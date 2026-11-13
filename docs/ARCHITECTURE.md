# Architecture

A web app (`web/`) and a Node server (`server/`) sit in front of Hermes agents. Hermes owns each Bot's agent loop, history, memory and model. The server adds the things Hermes does not have: the chat interface, one screen per Bot on the computer they share, connected apps with approvals, routines, the Library, and voice.

Everything runs on one Linux machine (by default an LXD container made by `local/corbot up`): the server, the Hermes gateways, the X displays and the Chromes. The optional outside services are Composio and xAI.

```text
browser ── HTTP + SSE ──► server ── POST /v1/responses ──► Hermes gateway (one per Bot)
   │                        ▲                                   │
   └── WebSocket (VNC) ─────┤◄──────── MCP: POST /mcp/<bot> ────┘
                            └── the computer: one X display per Bot
```

Contents: [Components](#components) · [A turn](#a-turn) · [Engines](#engines) · [App tools (MCP)](#app-tools-mcp) · [Approvals](#approvals) · [Screens and browsers](#screens-and-browsers) · [Viewer](#viewer) · [Transcript model](#transcript-model) · [Bots working together](#bots-working-together) · [Scheduling](#scheduling) · [Voice](#voice) · [Sign-in](#sign-in) · [Web app](#web-app) · [HTTP API](#http-api) · [Data](#data) · [On the machine](#on-the-machine) · [Settings](#settings) · [External services](#external-services) · [Checks](#checks) · [Kept but not in use](#kept-but-not-in-use)

## Components

| Piece | Where | What it does |
|---|---|---|
| Entry point | `server/src/index.ts` | Mounts `/mcp`, `/api/*`, serves `web/dist` when it exists, attaches the VNC relay, starts the schedulers, brings the managed gateways up and dresses the screens |
| API + realtime | `routes.ts`, `routes-config.ts`, `routes-rooms.ts`, `routes-proactive.ts`, `lib/hub.ts` | JSON over HTTP, plus one Server-Sent Events stream per user (`GET /api/events`) |
| Turns | `agent/loop.ts`, `agent/prompt.ts` | Per-Bot serial queue; posts each trigger to the Bot's gateway and turns the event stream into rows and live state. Also holds approvals |
| Engines | `engine.ts` | Which Hermes runs which Bot, managed homes and gateways, models, providers, API keys, subscription sign-in |
| App tools | `mcp.ts`, `agent/tools.ts` | The MCP endpoint and the tools behind it |
| Memory | `engine-memory.ts` | Reads the Bot's memory files in its Hermes home, removes one entry, and reports how full the conversation is |
| Screens | `screens.ts`, `computer.ts`, `desk.ts`, `box.ts`, `server/box/*` | X displays, screen leases, and the scripts that make a display look like a Bot's own desktop |
| Viewer | `vnc.ts`, `idle.ts` | WebSocket relay to a display's VNC server; viewer counts |
| Apps | `composio.ts`, `triggers.ts` | Catalog, sessions, connect links, tool execution, triggers for event routines, Google sign-in |
| Scheduling | `routines.ts`, `triggers.ts`, `proactive.ts` | Cron routines, event routines, check-ins |
| Group chats | `agent/rooms.ts` | A Bot row of kind `room`, with turn-taking done by the server |
| Voice | `voice.ts`, `web/src/voice/*` | Realtime voice calls, voice preview, dictation |
| Look | `eye.ts`, `web/src/avatar/BotAvatar.tsx` | A Bot's picture: one eye in one of 13 bodies. The geometry is shared; the web app animates it, the desktop uses a still |
| Storage | `db.ts`, `db-config.ts`, `store.ts`, `types.ts` | SQLite schema, row and Bot helpers, and the types the web app imports |
| UI | `web/src` | React + zustand |

## A turn

Something enqueues a trigger for a Bot (`enqueue` in `agent/loop.ts`): a user message, a routine, a message from another Bot, or a system notice (app connected, check-in, group chat). Each Bot handles one turn at a time. A user message closes any approval card still waiting.

1. `screenForWork` leases and dresses the Bot's screen and checks that its Chrome answers, so the agent never starts a browser of its own.
2. `engineFor` returns the gateway's URL and key, starting a managed gateway if needed.
3. The server posts to `<gateway>/v1/responses` with `stream: true`, `store: true`, the trigger text as `input`, the app's `instructions`, `conversation: corbot-<botId>-g<generation>`, the Bot's `model` and `provider` if it has them, and its reasoning effort.
4. The event stream becomes rows and live state:
   - `response.output_text.delta` rewrites the assistant message row (at most every 120 ms).
   - Reasoning deltas and `hermes.status` become the caption next to "Thinking".
   - A `function_call` item becomes a `tool-call` row and sets the activity (browsing, running commands, using a connected app…). Hermes' own `tool_search` and `tool_describe` are not shown.
   - A `function_call_output` item closes the row as done or error.
5. At the end, unfinished tool rows are closed and live state is cleared. An error or an interrupt (`POST /api/bots/:id/interrupt`) adds a notice row.

`instructionsFor` (`agent/prompt.ts`) is what the app adds to the agent's own system prompt: who the Bot is in the app, the app's tools, its screen, the team, group chats, routines, skills and the user's instructions. It must not depend on the clock, because it sits in the cached part of the prompt.

If the user took control of the screen and handed it back (`POST /api/bots/:id/handback`), the next turn starts with a note telling the Bot to look at its screen again.

## Engines

Every Bot is run by a Hermes gateway. The column `bots.engine` says which kind.

**Primary.** The first Bot is bound to the gateway that already runs on the computer (`HERMES_URL`, home `HERMES_HOME_PRIMARY`; in the default install, the `corbot-hermes` service). The rules:

- The app never restarts or stops it. `POST /api/bots/:id/engine/restart` refuses for this Bot.
- Giving it the app's tools is a separate step done at install time: `scripts/add-corbot-to-hermes.py` adds one `mcp_servers.corbot` entry pointing at `/mcp/primary`, keeps a copy of the file, and Hermes loads the change without a restart.
- At run time the app writes into that home in two cases only, both started by the user: pasting a provider API key (one line in its `.env`, plus a `providers` entry in `config.yaml` for a provider Hermes does not know, currently Mistral), and removing a memory entry.
- If that agent already has its own Chrome (`PRIMARY_CDP_URL`), the app never starts, stops or reconfigures it. In the default install this is not set and the app runs the Chrome on the main screen like any other.
- Its other sessions (Telegram, cron) see the same tools. When one of those sessions calls a tool that needs approval, the card shows up in the app.

**Managed.** Every other Bot gets a Hermes home under `ENGINES_DIR/<botId>` and its own `hermes gateway run --no-supervise`, on its own port (from `ENGINE_PORT_BASE`, 8650). `writeHome` creates or refreshes the home:

- `config.yaml` is created once from the primary's model settings (`model`, `providers`, `custom_providers`, `auxiliary`, fallbacks). After that only the app's keys are patched: `platform_toolsets.api_server` (with `computer_use`), `terminal.cwd` (the Bot's Library folder), `browser.cdp_url`, and `mcp_servers.corbot` (plus `EXTRA_MCP_SERVERS`).
- `.env` holds the API server settings and the model keys inherited from the primary. Messaging tokens are never copied.
- `auth.json` (subscription sign-ins) starts as a copy of the primary's; later sign-ins are the Bot's own.
- `SOUL.md` is the persona, rewritten on rename or new description.

The gateway is started detached with a minimal environment: `HERMES_HOME`, its `DISPLAY`, and its own `BH_HOME` (otherwise every agent would drive the same browser). It keeps running across an app restart, and the next start adopts it if it is healthy and accepts the stored key. Deleting the Bot stops it and deletes the home.

**Models and providers.** The Engine panel reads `GET <gateway>/api/model/options` and shows every provider with its models, connected ones first. A Bot's choice is stored in `bots.model` and `bots.provider` and sent with each turn. Three ways to connect a provider:

- Paste an API key (`POST /api/bots/:id/engine/key`). The key goes into the `.env` of every Bot of that user, so connecting once is enough. It is never sent back to the browser. An empty key disconnects.
- Sign in to a subscription (`POST /api/bots/:id/engine/login`). The server opens a terminal on the Bot's screen running `hermes auth add <provider>` (or `hermes model`), and the user finishes it in the viewer.
- Inherit it from the primary agent when the Bot is created.

Hermes can run a private "Bot Desktop" for an agent. While it is on, that agent's desktop work happens there and not on the screen the app shows. `EngineInfo.ownScreen` reports it and the panel offers a button to switch it off (`POST /api/bots/:id/engine/screen/stop`).

## App tools (MCP)

`POST /mcp/<botId>` and `POST /mcp/primary` speak MCP over streamable HTTP with JSON answers only (no server-to-client stream, no sessions). The bearer token is `HMAC-SHA256(SESSION_SECRET, "mcp:<botId>")`, so each gateway can only speak for its own Bot. `/mcp/primary` resolves to whichever Bot the primary engine is bound to, so that agent's config can be written before the Bot exists.

Tools (`agent/tools.ts`):

| Tool | For |
|---|---|
| `save_file` | Put a deliverable in the Bot's Library |
| `x_search` | Research on X through xAI (only with `XAI_API_KEY`) |
| `create_routine`, `list_routines`, `update_routine`, `delete_routine` | Cron routines |
| `list_event_triggers`, `create_event_routine` | Routines that run on an app event (only with `COMPOSIO_API_KEY`) |
| `set_checkins` | Check-in times for the main Bot |
| `create_task`, `update_task` | The task list the user sees |
| `send_to_bot` | Message another Bot |
| `create_group`, `post_to_group` | Group chats |
| `ask_user` | A multiple-choice question card; ends the turn |
| `request_app_connection` | A connect card; ends the turn (only with `COMPOSIO_API_KEY`) |
| `stay_silent` | End a turn without telling the user anything |

After these, the list carries the user's Composio session tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, …).

Hermes reports these tools with an `mcp_corbot_` prefix; `appToolName` strips it. When a call arrives, `claimToolRow` finds the `tool-call` row the event stream made for it, so the tool can set its own status and summary. A call made outside a turn started here (the primary agent talking to its owner elsewhere) simply has no row.

## Approvals

Approvals happen inside the MCP call, so they work the same for every engine (`policyFor` in `agent/tools.ts`, `requestApproval` in `agent/loop.ts`):

- The app's own tools run at once.
- For a Composio call, the server looks at the action slugs it would run. Slugs that only read (`_GET`, `_LIST`, `_SEARCH`, …) run at once.
- Anything else posts an **approval card** and the tool call waits. **Allow** runs it once, **Always allow** stores a per-tool policy, **Don't allow** returns a refusal that tells the agent not to retry.
- Code run in Composio's sandbox that reaches for app actions is treated like a write.
- A new user message, an interrupt, or no answer within 25 minutes closes the card and the call returns "skipped". The gateways' MCP timeout is 30 minutes.
- Waiting approvals live in memory: after a server restart, open cards are marked expired.

Not covered: what a Bot does through its browser or shell, and Hermes' own prompts for risky commands.

## Screens and browsers

**Displays** (`screens.ts`). Each screen is an X display with its own VNC server in one process (TigerVNC `Xvnc`), run by the systemd unit `corbot-screen@N` with an openbox window manager. Display `:99` is the main screen (id `default`); the others count up from `:100` (id `screen-100`, …). `local/provision.sh` starts `CORBOT_SCREENS` of them. Ports follow the display number:

| | Port |
|---|---|
| VNC server of display `:N` | `CORBOT_VNC_PORT_BASE` + N (5900 + N), on 127.0.0.1, no password |
| DevTools of the Chrome on display `:N` | 9200 + N (the main screen: 9299) |
| Home screen server | 7391, on 127.0.0.1 |

**Leases** (`computer.ts`). The `screens` table says which Bot has which screen. The primary Bot takes `default`; every other Bot takes a free extra display, or the server starts one more unit, up to `MAX_BOTS` in total. A lease is checked again after two minutes and replaced if the display is gone. Deleting a Bot frees its screen and removes its Chrome profile and Library folder.

**Dressing** (`desk.ts` and `server/box/`). The server installs the scripts of `server/box/` under `/opt/corbot` (once, and again when their hash changes) and calls `corbot-screen.py` with one short command per action. Slow work runs as a detached job that the server polls.

- `corbot-screen.py`: one-time machine setup (packages, Chrome policy, the home-screen extension), dressing, resetting and undressing a screen, opening a terminal.
- `corbot-shell.py`: one process per display; paints the wallpaper in the Bot's colour and a small dock (Browser, Terminal, Files).
- `corbot-home.py`: one server for every Chrome's new tab page. It works out which Bot is asking from the TCP connection (source port → process → Chrome profile or display) and serves that Bot's home screen (`home.html`).
- `ext/`: the new-tab extension, installed in every Chrome by policy.

A screen is dressed once per server run, again when the Bot's name or look changes, and for every leased screen at server start (`warmScreens`). `POST /api/bots/:id/screen/reset` closes what is open and brings Chrome back to the home screen; logins stay.

Two details matter:

- Hermes' browser tool finds its helper process under `BH_HOME`. Every managed gateway gets its own.
- A screen is dressed before the Bot's first turn (`screenForWork`), so the agent never finds an empty screen and starts a stray browser.

`box.ts` is the only way the server touches the machine's shell and disk for desktop work. Commands get a minimal environment with none of the server's secrets.

## Viewer

`GET /api/bots/:id/screen?mode=watch|control` upgrades to a WebSocket (`vnc.ts`). The relay checks the session cookie and that the Bot belongs to the user, connects to the display's VNC port over local TCP, performs the RFB handshake upstream, then offers the browser (noVNC) its own handshake. In `watch` mode, key, pointer and clipboard messages are dropped on the server; a client message of an unknown type is dropped too. Nagle is off on both sockets so input feels direct.

The details panel also uses `GET /api/bots/:id/screenshot` (a JPEG made with ImageMagick's `import`).

## Transcript model

A conversation is an append-mostly list of **rows**: `seq` (position), `updatedSeq` (a per-Bot revision counter), `kind` and a JSON `body`. A streaming reply is the same row rewritten with a higher `updatedSeq`, so clients upsert by `seq`. A per-Bot `generation` counter starts a new conversation and a new Hermes conversation (`POST /api/bots/:id/fresh`).

Row kinds: `message` (user or assistant, optionally `from` another Bot, a routine or a voice call), `tool-call` (an activity line and a collapsible step list), `card` (approval, question, connect, draft), `event` (routine run, task change, voice call, …), `notice`.

**Live state** is separate and not stored: per Bot, whether it is running, its current activity, what it is waiting for, when the turn started, the caption and the step count.

Events on `GET /api/events`: `hello`, `rows`, `cleared`, `live`, `roster`, `bot`, `computer`, `routines`, `tasks`, `memories`, `connections`, `ping` (every 20 s when idle). The web client reconnects with backoff and reloads Bots, computer state and the open transcript after a reconnect.

The model's own history is Hermes' business; the app keeps only what it shows. Memory is the same: it lives in the Bot's Hermes home (`memories/MEMORY.md` and `USER.md`, entries separated by a `§` line). The settings panel lists the entries, can remove one, and shows how full the conversation is, read from Hermes' session record and compression threshold (`contextUse`).

**Skills** are different: they are the app's own (`skills` table), written by the user in the Bot's settings and included in the instructions of every turn.

## Bots working together

- **`send_to_bot`** puts a message in another Bot's queue; the reply comes back the same way. A chain stops after 3 hops.
- **Group chats** are a Bot row with `kind='room'` and a member list; a room has no agent of its own. A user message goes to the @mentioned members, or to all of them (3 at most). Each gets the recent group messages and answers with `post_to_group`, or calls `stay_silent`.
- For work inside one task, Hermes' own delegation is used.

## Scheduling

- **Cron routines** (`routines.ts`): croner jobs, one per enabled routine, in the routine's timezone.
- **Event routines** (`triggers.ts`): a routine whose schedule is `event:<TRIGGER_SLUG>`, backed by a Composio trigger. Events arrive over Composio's realtime subscription, so no public webhook URL is needed. The event payload is appended to the routine's prompt.
- **Check-ins** (`proactive.ts`): up to 6 local times per user. At each one the main Bot gets a turn with a summary of open tasks, pending approvals and recent routine runs, and either sends one short message or calls `stay_silent`. Skipped when the user wrote in the last 20 minutes.

Each run is an ordinary turn. `CORBOT_NO_SCHEDULER=1` switches all three off, for a second server on a copy of the database.

## Voice

Needs `XAI_API_KEY`. A call is a second, light agent that runs in the browser against xAI's realtime API and speaks as the Bot (`web/src/voice/call.ts`).

1. `POST /api/voice/session` mints a client secret valid for 5 minutes, builds the voice agent's instructions (persona, memories, routines, recent chat, what the Bot is doing now) and adds a "call started" row.
2. The browser opens the WebSocket to xAI directly, with 24 kHz PCM both ways and server-side voice detection. The server's key never reaches the browser.
3. The voice agent's tools are served by `POST /api/voice/tool`: `send_task` (puts the request in the Bot's normal turn queue), `recall_text_messages`, `search_conversations`, `peek_activity`, `end_the_call`.
4. When the text agent finishes, the browser sees the result in the transcript stream and injects it into the call as a `[work_landed]` note, which the voice agent speaks.
5. `POST /api/voice/end` writes the call record (duration, transcript, tasks) and a summary.

`POST /api/voice/preview` proxies text-to-speech for the voice picker and `POST /api/voice/stt` proxies speech-to-text for dictation in the composer. Voice, speed and language are per Bot.

## Sign-in

Sessions are a random token in an HTTP-only cookie (`corbot_session`, 30 days), stored in `auth_sessions`. Ways in:

| Way | Endpoint | When |
|---|---|---|
| Email form | `POST /api/auth/dev` | `DEV_LOGIN=1` (the default of the local install, which listens on 127.0.0.1 only) |
| Google | `GET /api/auth/google/start` | With `COMPOSIO_API_KEY`; uses a Composio-managed Google connection to read the profile |
| Owner key | `POST /api/auth/owner` | The bearer key is `HMAC-SHA256(SESSION_SECRET, "owner-login")`, so only someone who can read the server's `.env` can make it |
| One-time link | `GET /api/auth/link/:token` | Made by the owner endpoint (`scripts/sign-in-link.sh <email>`); valid once, for 15 minutes, kept in memory |

`ALLOWED_EMAILS` limits who can create an account; existing accounts are not affected. A new account gets the main Bot (`PRIMARY_BOT_NAME`, `PRIMARY_BOT_LABEL`).

`GET /api/auth/me` also returns `features` (`googleLogin`, `apps`, `voice`), which the web app uses to hide what the server cannot do.

## Web app

React 18, zustand, Vite. No router: one shell (`App.tsx`) with a sidebar, the chat or the Tasks view, the details panel, and layers for modals, settings and the large screen view.

- **Shared code.** `@shared` is an alias for `server/src`; the web app imports `types.ts` and `eye.ts` from there.
- **State.** `store.ts` (Bots, live state, transcripts by `seq`, routines, computer, which panels are open), `configStore.ts` (settings layers, the Tasks view, theme), `voice/call.ts` (the call), `i18n/index.ts` (language).
- **Data.** `lib/api.ts` and `lib/configApi.ts` for HTTP, `lib/events.ts` for the one EventSource.
- **Components.** `Sidebar`, `ChatView` → `Transcript` + `Composer`, `ActivityLine` (the "thinking" chip), `cards/Cards` (approval, question, connect, draft), `DetailsPanel` (screen preview; Activity, Tasks and Library tabs; Engine and Voice), `ComputerViewer` (noVNC, watch or control), `EngineSettings`, `VoiceSettings`, `VoiceCallBar`, `config/BotSettingsModal` (General, Skills, Memories, Routines), `config/AppSettings` (General, Computer, Permissions, Apps, Account), `config/TasksView`, and the modals (create Bot, create group, search, connect apps).
- **Languages.** English is the source: the English sentence is the key (`t`, `tn`, `tx`), with dictionaries for French, Spanish, Italian, German and Portuguese. `node tools/i18n-check.mjs` fails when a sentence has no translation, a translation is left over, or the `{values}` differ.
- **Layout.** Two breakpoints, kept in step between `lib/responsive.ts` and `styles/responsive.css`: under 1100 px the details panel floats over the chat, under 640 px the sidebar is a drawer. On phones the app follows the visual viewport so the composer stays above the keyboard.
- **Look.** Light, dark or system theme (`data-theme` on the root). `styles/glass.css` is imported last and gives the floating pieces a translucent surface where the browser supports it.
- **Shortcuts.** With Ctrl or Command: K search, B sidebar, Shift+, details, comma settings, I focus the composer. `lib/keys.ts` writes them the way the person's keyboard names them (`⌘K` on Apple devices, `Ctrl+K` elsewhere, key names translated).

In development, Vite serves on 5173 and proxies `/api` (WebSocket included) to `CORBOT_API` (default `http://localhost:8787`). In production the server serves `web/dist` itself.

## HTTP API

All under `/api`, JSON, and behind the session cookie except `/api/health`, `/api/auth/*` and `/api/apps/callback`.

| Area | Endpoints |
|---|---|
| Health, events | `GET /health` · `GET /events` (SSE) |
| Auth | `GET /auth/me` · `GET /auth/google/start` · `GET /auth/google/callback` · `POST /auth/dev` · `POST /auth/owner` · `GET /auth/link/:token` · `POST /auth/logout` |
| Bots | `GET /bots` · `POST /bots` · `PATCH /bots/:id` · `DELETE /bots/:id` · `POST /bots/:id/primary` · `POST /bots/:id/read` |
| Conversation | `GET /bots/:id/rows` · `POST /bots/:id/messages` · `POST /bots/:id/interrupt` · `POST /bots/:id/fresh` |
| Cards | `POST /approvals/:id` · `POST /bots/:id/cards/:seq/answer` · `POST /bots/:id/cards/:seq/dismiss` |
| Routines, tasks | `GET /bots/:id/routines` · `PATCH /routines/:id` · `POST /routines/:id/run` · `DELETE /routines/:id` · `GET /bots/:id/tasks` · `GET /tasks` |
| Settings, memory, skills | `GET /bots/:id/settings` · `GET /bots/:id/memories` · `DELETE /memories/:id` · `GET /bots/:id/skills` · `POST /bots/:id/skills` · `PATCH /skills/:id` · `DELETE /skills/:id` |
| Engine | `GET /bots/:id/engine` · `PATCH /bots/:id/engine` · `POST /bots/:id/engine/login` · `POST /bots/:id/engine/key` · `POST /bots/:id/engine/restart` · `POST /bots/:id/engine/screen/stop` |
| Computer | `GET /computer` · `POST /computer/ensure` · `GET /computer/details` · `GET /bots/:id/screenshot` · `POST /bots/:id/screen/reset` · `POST /bots/:id/handback` · `GET /bots/:id/screen` (WebSocket) |
| Library | `GET /bots/:id/files` · `POST /bots/:id/files/download` · `GET /bots/:id/files/raw` |
| Apps | `GET /apps` · `POST /apps/:slug/connect` · `GET /apps/callback` · `DELETE /apps/:slug` · `GET /policies` · `DELETE /policies/:tool` |
| Group chats | `POST /rooms` · `GET /rooms/:id/members` · `PUT /rooms/:id/members` |
| Check-ins | `GET /checkins` · `PUT /checkins` · `POST /checkins/now` |
| Voice | `GET /voice/options` · `POST /voice/session` · `POST /voice/tool` · `POST /voice/end` · `POST /voice/preview` · `POST /voice/stt` |

Outside `/api`: `POST /mcp/:bot` for the gateways.

Library downloads resolve links before checking the path, so a link inside a Library cannot point outside it.

## Data

SQLite (`DB_PATH`, WAL, foreign keys on). The schema is created in `db.ts`; later columns are added by idempotent `ALTER`s there and in `db-config.ts`, `agent/rooms.ts`, `agent/subagents.ts` and `triggers.ts`.

| Table | Holds |
|---|---|
| `users`, `auth_sessions`, `login_attempts` | Accounts, sessions, Google sign-ins in progress |
| `bots` | Bots and group chats: look, instructions, voice, `engine`, `engine_port`, `model`, `provider`, `generation`, `kind`, `members` |
| `rows` | Transcripts |
| `approvals`, `policies` | Approval cards and "always allow" choices |
| `routines`, `tasks`, `skills` | Per Bot |
| `proactivity` | Check-in settings per user |
| `computers`, `screens` | Computer status per user, screen lease per Bot |
| `composio_sessions` | Composio session id per user |

Outside the database: each managed Bot's Hermes home under `ENGINES_DIR`, Chrome profiles in `/root/corbot/profiles/<botId>`, Library files in `/root/corbot/files/<botId>`. Deleting a Bot removes its gateway, home, profile, files and screen lease.

Secrets live in the app's `.env` and in each Hermes home (`.env`, `auth.json`, both mode 600).

## On the machine

What `local/provision.sh` and `local/install-app.sh` put in place:

| Path | What |
|---|---|
| `/opt/corbot/app` | The app (`server/dist`, `server/box`, `web/dist`) and its `.env` |
| `/opt/corbot/data` | `corbot.db` and `engines/<botId>/` |
| `/opt/corbot/node` | Node 22 |
| `/opt/corbot/*.py`, `ext/`, `screens/`, `jobs/` | The desktop scripts and their state, installed by the server |
| `/root/.hermes` | The main agent's Hermes home |
| `/root/corbot/files`, `/root/corbot/profiles` | Libraries and Chrome profiles |
| `/var/log/corbot` | `app.log`, `hermes.log`, `npm.log` |

Services: `corbot-screen@N` (one per display), `corbot-hermes` (the main agent's gateway, API on 127.0.0.1:8642, on display `:99`), `corbot-app` (the server; `KillMode=process`, so the managed gateways survive an app restart).

`local/corbot` drives this from the host: `up`, `deploy`, `model`, `status`, `logs`, `shell`, `stop`, `start`, `destroy`. The app listens inside the container on 127.0.0.1; an LXD proxy device forwards the same port on the host's 127.0.0.1. `scripts/pack.sh` builds the tarball that `install-app.sh` unpacks. An upgrade replaces code only; `.env` and data are kept.

## Settings

Read in `server/src/env.ts`; `.env.example` explains each one.

| Group | Keys |
|---|---|
| App | `PORT`, `HOST`, `APP_URL`, `SERVER_URL`, `SESSION_SECRET` (required), `DEV_LOGIN`, `ALLOWED_EMAILS`, `DB_PATH` |
| Engines | `HERMES_BIN`, `HERMES_URL`, `HERMES_HOME_PRIMARY`, `HERMES_KEY`, `ENGINES_DIR`, `ENGINE_PORT_BASE`, `MCP_BASE_URL`, `EXTRA_MCP_SERVERS`, `PRIMARY_BOT_NAME`, `PRIMARY_BOT_LABEL` |
| Computer | `MAX_BOTS`, `CORBOT_VNC_PORT_BASE`, `PRIMARY_CDP_URL` |
| Optional services | `COMPOSIO_API_KEY`, `XAI_API_KEY`, `XAI_MODEL`, `XAI_VOICE_MODEL`, `XAI_STT_MODEL` |
| Development | `CORBOT_NO_SCHEDULER`, `CORBOT_API` (Vite proxy target) |

Without `COMPOSIO_API_KEY`: no connected apps, event routines or Google sign-in, and the tools that need them are not offered to the agents. Without `XAI_API_KEY`: no voice, dictation or `x_search`.

## External services

| Service | Used for |
|---|---|
| Hermes Agent | The agent loop, tools, memory and model access for every Bot (API keys or subscription sign-ins) |
| Composio | Connected apps and their actions, triggers, Google sign-in |
| xAI | Research on X (`x_search`), realtime voice, TTS, dictation |

## Checks

There are no unit tests; the checks run against a real server.

| Command | What it checks |
|---|---|
| `npm run typecheck` | Server and web types |
| `node tools/i18n-check.mjs` | Translations |
| `node tests/e2e.mjs [baseUrl]` | Playwright: creates a throwaway Bot with its own gateway and screen, exercises chat, browser, viewer, apps, voice sessions and settings, then deletes it. Needs `DEV_LOGIN=1` or `E2E_SESSION`. Calls real providers |
| `node tests/local-screen.mjs <baseUrl> <botId> <session cookie> [watch\|control]` | The live screen through the relay: handshake, a full frame, frame rate |
| `node tests/voice-call.mjs <outDir> <botId>` | A two-way voice call in headless Chrome with a fake microphone. Expects the audio file as `<outDir>/ask-fixed.wav` (`tests/ask-weather.wav` is the source recording) and changes that Bot's voice settings |

## Kept but not in use

Left from earlier designs. Worth knowing before building on them:

- **Sleep.** The computer is the machine the server runs on and is never suspended. `idle.ts` still counts viewers, but `startIdleWatcher` starts nothing, `suspendComputer` does nothing, and of the `ComputerState` statuses only `running`, `error` and the initial `starting` occur. The Computer page of the settings still shows Sleep and Wake buttons and text about a cloud computer.
- **Subagents.** `agent/subagents.ts` adds the `parent_bot_id` and `hidden` columns, which queries filter on, but nothing calls `createSubagent`. Delegation inside a task is Hermes' own.
- **History and memory in the database.** `llm_items`, `pending_turns`, `memories`, `memory_jobs` and `compactions` exist but Hermes now keeps history and memory. `POST /bots/:id/memories/consolidate` and `POST /bots/:id/compact` answer with empty results so older clients do not fail.
- **Bot type.** `bots.mode` (`personal` or `teammate`) can be chosen when creating a Bot and in its settings, but it only changes the text of an empty chat. The server does nothing with it.
