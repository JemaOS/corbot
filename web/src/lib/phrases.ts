import type { ActivityKind, LiveState, Row } from '@shared/types';
import { t, tx } from '../i18n';

/** textKind → phrase table from docs/research/03-ui-design.md §2.4. Arrays rotate. */
const PHRASES: Record<string, string[]> = {
  thinking: [tx('Thinking it through'), tx('Mulling it over'), tx('Putting it together')],
  working: [tx('Getting it done'), tx('Making progress'), tx('Working on it'), tx('Handling it'), tx('Chipping away')],
  searching_web: [tx('Digging around')],
  reading_web: [tx('Doing some reading')],
  browsing_web: [tx('Clicking through pages')],
  reading_file: [tx('Reading the file')],
  drafting_file: [tx('Jotting it down')],
  organizing_files: [tx('Moving files over')],
  on_your_computer: [tx('Working on your computer')],
  on_its_computer: [tx('Clicking around')],
  running_commands: [tx('Running a few commands')],
  waiting_on_command: [tx('Waiting on results')],
  coding: [tx('Writing some code')],
  generating_photo: [tx('Sketching something up')],
  generating_video: [tx('Filming a clip')],
  messaging_assistant: [tx('Checking with another Bot')],
  messaging: [tx('Sending a message')],
  connecting_app: [tx('Working in a connected app')],
  waiting_for_you: [tx('Needs your input')],
  checking_usage: [tx('Checking your usage')],
  remembering: [tx('Making a note of it')],
};

const nice = (s?: string) => !!s && !/[_]/.test(s) && !/^[a-z0-9-]+$/.test(s);

/** Name of the bot being messaged: the running call's `bot_name` argument, else a readable `detail`. */
function messagedName(live: LiveState, rows: Row[]): string | null {
  const running = [...rows].reverse().find((r) => r.body.type === 'tool-call' && r.body.status === 'running');
  const args = running?.body.type === 'tool-call' ? (running.body.args as Record<string, unknown> | undefined) : undefined;
  if (typeof args?.bot_name === 'string') return args.bot_name;
  return nice(live.activity?.detail) ? live.activity!.detail! : null;
}

/** Phrase for the live caption when the server sent none. `tick` rotates multi-phrase kinds. */
export function activityPhrase(live: LiveState, rows: Row[], tick: number): string {
  const a = live.activity;
  if (!a) return live.awaiting ? t('Needs your input') : t('Working on it');
  const kind = a.kind as ActivityKind;
  if (kind === 'messaging_named') {
    const name = messagedName(live, rows);
    return name ? t('Checking with {name}', { name }) : t('Checking with another Bot');
  }
  if (kind === 'connecting_service') return nice(a.detail) ? t('Working in {app}', { app: a.detail! }) : t('Working in a connected app');
  const list = PHRASES[kind] ?? PHRASES.working;
  return t(list[tick % list.length]);
}

/** One or two words for the status pill under the bot's name. */
const STATUS: Record<ActivityKind, string> = {
  thinking: tx('Thinking'),
  working: tx('Working'),
  searching_web: tx('Searching'),
  reading_web: tx('Reading'),
  browsing_web: tx('Browsing'),
  on_its_computer: tx('On its computer'),
  running_commands: tx('Running commands'),
  waiting_on_command: tx('Waiting on results'),
  messaging_named: tx('Checking in'),
  connecting_service: tx('Using an app'),
  waiting_for_you: tx('Needs you'),
  drafting_file: tx('Writing'),
  remembering: tx('Remembering'),
};

/** True when the bot has stopped to wait for the person (approval, question, connect). */
export function isWaitingForYou(live: LiveState | undefined): boolean {
  return !!live && (!!live.awaiting || live.activity?.kind === 'waiting_for_you');
}

/** Short status word for the pill: "Thinking", "Browsing", "Working in Gmail", "Needs you". */
export function activityStatus(live: LiveState, rows: Row[]): string {
  if (isWaitingForYou(live)) return t('Needs you');
  const a = live.activity;
  if (!a) return t('Thinking');
  if (a.kind === 'messaging_named') {
    const name = messagedName(live, rows);
    return name ? t('Checking with {name}', { name }) : t(STATUS.messaging_named);
  }
  if (a.kind === 'connecting_service') return nice(a.detail) ? t('Working in {app}', { app: a.detail! }) : t(STATUS.connecting_service);
  return t(STATUS[a.kind] ?? tx('Working'));
}

/**
 * The fixed step labels the server sends (server/src/agent/tools.ts, loop.ts). Marked here so they
 * are translated; a label not in this list (an app's own name for an action) is shown as received.
 */
export const SERVER_LABELS = [
  tx('Browsing a site'),
  tx('Checking routines'),
  tx('Finishing up'),
  tx('Handing off work'),
  tx('Looking at an image'),
  tx('Making a task'),
  tx('Messaging a Bot'),
  tx('Planning'),
  tx('Posting to the group'),
  tx('Reading a page'),
  tx('Reading files'),
  tx('Removing a routine'),
  tx('Running commands'),
  tx('Saving a file'),
  tx('Saving notes'),
  tx('Scheduling'),
  tx('Searching X'),
  tx('Searching memory'),
  tx('Searching the web'),
  tx('Sending a message'),
  tx('Setting up a group'),
  tx('Setting up a routine'),
  tx('Updating a routine'),
  tx('Updating a task'),
  tx('Updating check-ins'),
  tx('Using a connected app'),
  tx('Using a skill'),
  tx('Using its computer'),
  tx('Waiting on you'),
  tx('Writing a file'),
];

/** A server label in the current language. */
export const serverLabel = (label: string | undefined | null): string => (label ? t(label) : '');

/** English schedule words the server wrote into an old line, in the current language. */
function scheduleWords(s: string): string {
  let m: RegExpExecArray | null;
  if (s === 'Paused') return t('Paused');
  if (s === 'Every hour') return t('Every hour');
  if ((m = /^Every day at (.+)$/.exec(s))) return t('Every day at {time}', { time: m[1] });
  if ((m = /^Weekdays at (.+)$/.exec(s))) return t('Weekdays at {time}', { time: m[1] });
  if ((m = /^Every (\d+) minutes$/.exec(s))) return t('Every {n} minutes', { n: m[1] });
  if ((m = /^Every (\d+) hours$/.exec(s))) return t('Every {n} hours', { n: m[1] });
  if ((m = /^When ([^:]+): (.+)$/.exec(s))) return t('When {app}: {event}', { app: m[1], event: m[2] });
  return s;
}

/**
 * A line the server wrote into the conversation ("Running routine: Morning brief"), in the current
 * language. These lines are stored in English, so they are recognised by their shape; anything
 * else (an error from a service, a bot's own words) is shown as received.
 */
export function serverText(text: string): string {
  let m: RegExpExecArray | null;
  if (text === 'Stopped.') return t('Stopped.');
  if (text === 'This group has no Bots yet.') return t('This group has no Bots yet.');
  if ((m = /^Running routine: (.+)$/s.exec(text))) return t('Running routine: {name}', { name: m[1] });
  if ((m = /^Routine triggered: (.+)$/s.exec(text))) return t('Routine triggered: {name}', { name: m[1] });
  if ((m = /^Routine created: (.+) · ([^·]+)$/s.exec(text))) return t('Routine created: {name} · {when}', { name: m[1], when: scheduleWords(m[2]) });
  if ((m = /^Routine updated: (.+) · ([^·]+)$/s.exec(text))) return t('Routine updated: {name} · {when}', { name: m[1], when: scheduleWords(m[2]) });
  if ((m = /^Group created with (.+)$/s.exec(text))) return t('Group created with {names}', { names: m[1] });
  if ((m = /^Something went wrong: (.+)$/s.exec(text))) return t('Something went wrong: {reason}', { reason: m[1] });
  if ((m = /^(.+) joined · (.+) left$/s.exec(text))) return t('{joined} joined · {left} left', { joined: m[1], left: m[2] });
  if ((m = /^(.+) joined$/s.exec(text))) return t('{names} joined', { names: m[1] });
  if ((m = /^(.+) left$/s.exec(text))) return t('{names} left', { names: m[1] });
  if ((m = /^Allow (.+?) to (.+)\?$/s.exec(text))) return t('Allow {name} to {action}?', { name: m[1], action: m[2] === 'Run code that uses your connected apps' ? t('run code that uses your connected apps') : m[2] });
  return text;
}
