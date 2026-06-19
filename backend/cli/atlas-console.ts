/**
 * `pnpm atlas` — a dev CLI to drive + observe Atlas from the terminal, via the slack-app's dev-console
 * HTTP seam (mounted only when DEV_CONSOLE_ENABLED). Lets me create fresh Atlas threads and watch what
 * he does (gate / tool calls / sessions / cost), the way Dennis drives Atlas in Slack.
 *
 *   pnpm atlas new [--project <id>] [--team <id>]   # start a fresh, clean thread
 *   pnpm atlas say "<message>"                       # send as a user; wait for + print Atlas's reply
 *   pnpm atlas tail                                  # stream the current thread's activity
 *
 * Run via `pnpm atlas` so env is injected (DEV_CONSOLE_TOKEN + PORT). Never reachable in prod.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT ?? '4001';
const BASE = `http://localhost:${PORT}/dev/console`;
const TOKEN = process.env.DEV_CONSOLE_TOKEN;
const STATE = join(tmpdir(), 'atlas-console-thread.json');

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

interface TraceItem {
  seq: number;
  kind: string;
  text: string;
}
interface SessionView {
  id: string;
  status: string;
  mode: string;
  task: string;
  lastReport?: string;
}
interface EventsView {
  cursor: number;
  settled: boolean;
  reply?: string;
  trace: TraceItem[];
  sessions: SessionView[];
  cost?: string;
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!TOKEN)
    die('DEV_CONSOLE_TOKEN not set — run via `pnpm atlas` (it injects env).');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-dev-console-token': TOKEN as string,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((e: unknown) =>
    die(
      `cannot reach the dev console at ${BASE} — is slack:dev running with DEV_CONSOLE_ENABLED? (${String(e)})`,
    ),
  );
  if (!res.ok) die(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const saveThread = (channelId: string): void =>
  writeFileSync(STATE, JSON.stringify({ channelId }));
const loadThread = (): string => {
  if (!existsSync(STATE)) die('No current thread — run `pnpm atlas new` first.');
  return (JSON.parse(readFileSync(STATE, 'utf8')) as { channelId: string })
    .channelId;
};

function printSettled(ev: EventsView): void {
  if (ev.sessions.length) {
    console.log('  sessions:');
    for (const s of ev.sessions)
      console.log(
        `    [${s.status}] ${s.mode} — ${s.task}${s.lastReport ? ` → ${s.lastReport.slice(0, 240)}` : ''}`,
      );
  }
  if (ev.cost) console.log(`  cost: ${ev.cost}`);
}

async function cmdNew(args: string[]): Promise<void> {
  const project = flag(args, '--project');
  const team = flag(args, '--team');
  const { channelId } = await api<{ channelId: string }>('POST', '/threads', {
    project,
    team,
  });
  saveThread(channelId);
  console.log(
    `new thread: ${channelId}${project ? ` (project ${project})` : ''}`,
  );
}

async function cmdSay(args: string[]): Promise<void> {
  const channelId = loadThread();
  const text = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!text) die('usage: pnpm atlas say "<message>"');
  const { cursor } = await api<{ cursor: number }>('POST', '/say', {
    channelId,
    text,
  });
  console.log(`you: ${text}`);
  let printed = cursor;
  const deadline = Date.now() + 180_000;
  for (;;) {
    await sleep(700);
    const ev = await api<EventsView>(
      'GET',
      `/events?channelId=${enc(channelId)}&since=${cursor}`,
    );
    for (const t of ev.trace)
      if (t.seq > printed) {
        console.log(`  ${t.text}`);
        printed = t.seq;
      }
    if (ev.settled) {
      printSettled(ev);
      return;
    }
    if (Date.now() > deadline) {
      console.log('  (still running — `pnpm atlas tail` to keep watching)');
      return;
    }
  }
}

async function cmdTail(): Promise<void> {
  const channelId = loadThread();
  console.log(`tailing ${channelId} (ctrl-c to stop)`);
  let printed = 0;
  for (;;) {
    const ev = await api<EventsView>(
      'GET',
      `/events?channelId=${enc(channelId)}&since=0`,
    );
    for (const t of ev.trace)
      if (t.seq > printed) {
        console.log(`  ${t.text}`);
        printed = t.seq;
      }
    await sleep(700);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'new':
      return cmdNew(args);
    case 'say':
      return cmdSay(args);
    case 'tail':
      return cmdTail();
    default:
      die('usage: pnpm atlas <new|say|tail> …');
  }
}

void main();
