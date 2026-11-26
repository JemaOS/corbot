# Corbot — screens do not load over Tailscale

Diagnosis written against `7d663c9` by reading the code only. **No reproduction on a tailnet yet**: the
last section lists the checks that would confirm each cause before changing anything.

Symptom: signing in to the app through Tailscale works, but every bot's screen (the computer view)
stays blank on phones, tablets and other computers.

The screen travels through a different path than the rest of the app, and that path has three
independent ways to fail on a tailnet. All three are silent in the UI: no message, just a frame that
never shows a picture.

## How a screen renders, and where it can break

`web/src/components/ComputerViewer.tsx:99` opens noVNC against

```
(ws|wss)://<location.host>/api/bots/<botId>/screen?mode=watch|control
```

`server/src/vnc.ts:146-158` upgrades that socket, checks the session cookie, then relays to the
display's own VNC server at `127.0.0.1:5900+N` (`server/src/screens.ts:103`, `local/provision.sh:48`).

So the failure is in one of these three places.

### 1. The screen connects over `ws://`, on a page the phone may treat as insecure

`ComputerViewer.tsx:98` chooses `wss` only when `location.protocol === 'https:'`. Corbot ships no TLS
story anywhere (`local/`, `install.sh`, `install.ps1`: no Caddy, no Tailscale `serve`/`cert`), so the
app is served over plain `http://` — including over the tailnet. Consequences:

- **Phones**: Chrome on Android and Safari on iOS increasingly restrict active mixed content, and iOS
  is the stricter of the two. A plain-`ws://` socket to a non-localhost host is exactly what they
  clamp down on.
- **Secure-context assumptions**: on a non-`localhost` `http://` origin, `isSecureContext` is false.
  NoVNC itself does not need it, but anything that leans on `crypto.subtle` or similar does.
- This explains the asymmetry in the report: **the machine running Corbot** opens
  `http://localhost:8787`, which browsers treat as a secure, trusted origin; every *other* device
  (phone, tablet, laptop over Tailscale) opens `http://<tailscale-name>:8787`, which does not get
  those exceptions.

**Fix direction**: serve the app over HTTPS for the tailnet. Tailscale makes this cheap —
`tailscale serve --bg https / http://127.0.0.1:8787` gives a `https://<machine>.<tailnet>.ts.net`
address with a valid certificate, and the viewer then naturally uses `wss://`. `local/` should offer
it, and `APP_URL`/`SERVER_URL` must be set to that `https://` address (see point 3).

### 2. The display's VNC server may refuse the loopback relay

`local/provision.sh:48` starts the display with `-localhost=1`. The relay connects to `127.0.0.1`,
so that is fine **inside the container**. It breaks as soon as the app is not in the same network
namespace as the display:

- The launcher publishes the app with `lxc config device add "$NAME" corbot-app proxy
  listen=tcp:127.0.0.1:$PORT connect=tcp:127.0.0.1:$PORT` (`local/corbot:74`): again loopback only,
  which is consistent with "the app is only reachable from this machine" — and inconsistent with
  reaching it over Tailscale at all.

If the deployment people use over Tailscale is a variant where the app is reachable but the VNC
servers are not on `127.0.0.1` from the app's point of view, the relay's `connectTcp` fails and the
browser sees a socket that closes with 1011 (logged as `[vnc] relay failed`). Check `journalctl`-style
logs for that exact line.

**Fix direction**: either keep both in one namespace (recommended), or make the VNC bind address
configurable (`CORBOT_VNC_HOST`, `-localhost=0` behind a firewall) rather than hard-coded.

### 3. `APP_URL` is what the server considers its own origin

`server/src/lib/auth.ts:17` sets the session cookie with `secure` **only if `APP_URL` starts with
`https:`**, and same-site `Lax`. `local/install-app.sh:14` defaults `PUBLIC_URL` to
`http://localhost:8787` and writes it into both `APP_URL` and `SERVER_URL`. So a tailnet deployment
that never sets `PUBLIC_URL` has a server that still believes it lives on `localhost`:

- the cookie is issued non-`secure` and for whatever host the browser used, which is fine, but
- any redirect the server builds (`server/src/routes.ts:73,85,94`, and the sign-in link at
  `routes.ts:128`) sends the person to `http://localhost:8787/...`, which on a phone is the phone.
- once the app *is* served over HTTPS (point 1), a cookie marked non-`secure` while `APP_URL` still
  says `http://` is the classic combination that browsers drop.

**Fix direction**: `PUBLIC_URL` must be the tailnet address, and the installers/launcher should
require it (or detect the Tailscale name) rather than silently defaulting to `localhost`.

## What is *not* the cause

- The relay itself preserves frames, flushes both directions after the handshake and sets `NoDelay`
  (`server/src/vnc.ts:37,196-206`); there is no obvious buffering or framing bug here.
- The cookie is `httpOnly` + `Lax` with `path=/` and is checked on the upgrade request
  (`server/src/vnc.ts:149-153`), so an authenticated app session should be enough for the screen too —
  **unless** a reverse proxy strips the `Cookie` header on the upgrade request. That is worth
  verifying with the proxy in place (see below), because it fails exactly like an auth failure: 401 on
  the socket, no picture, no message.

## Confirming it, in order

1. On a phone or another computer over Tailscale, open devtools/remote debugging and watch the
   `/api/bots/<id>/screen` WebSocket: does it connect and then close, or never open at all?
2. On the server: does `[vnc] relay failed` appear when the phone tries? That points at point 2. A
   clean 1011 with no log line points at the handshake never reaching the relay.
3. Compute the URL the page uses: `location.protocol` on the phone. If it is `http:` and you want
   HTTPS, that is point 1.
4. `grep APP_URL` on the deployment's `.env`. If it says `localhost`, that is point 3.
5. If a reverse proxy sits in front (Tailscale `serve`/`funnel` or Caddy), check that it forwards the
   `Upgrade`/`Connection` headers and the `Cookie` header on `101 Switching Protocols`.

## Suggested order of work

1. Make `PUBLIC_URL` mandatory for non-local deployments and document the Tailscale variant.
2. Add `tailscale serve` (HTTPS) to `local/` as the supported remote-access path.
3. Log the refusal reason from the relay to the browser (a short text frame before closing), so a
   blank screen becomes a sentence instead of a silence.
4. Add a smoke test for the relay over `wss` behind a TLS-terminating proxy (`tests/` already has
   e2e harnesses to extend).
