import Redis from 'ioredis';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ScenarioResult {
  pass: boolean;
  detail: string;
}
export type Scenario = (sandbox: string) => Promise<ScenarioResult>;

export const REDIS_URL_HOST = 'redis://127.0.0.1:6380';
export const REDIS_URL_CONTAINER = process.env.E2E_SANDBOX_REDIS_URL ?? 'redis://redis:6379';
export const HAIKU = 'claude-haiku-4-5-20251001';

export type Frame = Record<string, unknown> & { t?: string };

export function turnKeys(turnId: string) {
  return {
    spec: `turn:${turnId}:spec`,
    events: `turn:${turnId}:events`,
    tools: `turn:${turnId}:tools`,
    replies: `turn:${turnId}:replies`,
    abort: `turn:${turnId}:abort`,
    input: `turn:${turnId}:input`,
  };
}

export function newRedis(): Redis {
  return new Redis(REDIS_URL_HOST);
}

export function xadd(redis: Redis, stream: string, frame: unknown): Promise<string> {
  return redis.xadd(stream, '*', 'data', JSON.stringify(frame)) as Promise<string>;
}

export function decode(fields: string[]): Frame | null {
  const i = fields.indexOf('data');
  if (i < 0) return null;
  try {
    return JSON.parse(fields[i + 1]) as Frame;
  } catch {
    return null;
  }
}

export function authFromEnv(): { secret: string; kind?: 'personal' | 'setup-token' } {
  const secret = process.env.CLAUDE_OAUTH_TOKEN;
  if (!secret) {
    throw new Error(
      'CLAUDE_OAUTH_TOKEN is required (run under: npx dotenvx run -f .env.seed.enc ... -- npx tsx <script> <container>)',
    );
  }
  try {
    const j = JSON.parse(secret) as { claudeAiOauth?: { accessToken?: unknown } };
    if (typeof j?.claudeAiOauth?.accessToken === 'string') {
      return { secret, kind: 'personal' };
    }
  } catch {}
  return { secret };
}

export interface SpecOverrides {
  task?: string;
  systemPrompt?: string;
  mode?: 'plan' | 'review' | 'execute';
  steerable?: boolean;
  richStream?: boolean;
  toolBridgeTools?: string[];
  auth?: false;
  homeType?: 'brain' | 'build' | 'plan-review' | 'autofix' | 'review';
  [k: string]: unknown;
}

export function makeSpec(turnId: string, o: SpecOverrides = {}): Record<string, unknown> {
  const {
    task,
    systemPrompt,
    mode,
    steerable,
    richStream,
    toolBridgeTools,
    auth,
    homeType,
    ...rest
  } = o;
  const spec: Record<string, unknown> = {
    turnId,
    engine: 'claude',
    model: HAIKU,
    task: task ?? 'Reply with exactly one word: pong. Do not call any tools.',
    systemPrompt: systemPrompt ?? 'You are a terse test assistant.',
    cwd: '/workspace',
    writableRoots: [],
    sandboxKey: {
      orgId: 'e2e',
      repoId: 'e2e',
      jobId: turnId.slice(0, 8),
      type: homeType ?? 'review',
    },
    mode: mode ?? 'review',
    ...(steerable ? { steerable: true } : {}),
    ...(richStream ? { richStream: true } : {}),
    ...(toolBridgeTools ? { toolBridgeTools } : {}),
    ...rest,
  };
  if (auth !== false) spec.auth = authFromEnv();
  return spec;
}

export interface KickOptions {
  detached?: boolean;
  extraEnv?: Record<string, string>;
  quiet?: boolean;
  timeoutMs?: number;
}

function kickEnvArgs(turnId: string, extraEnv?: Record<string, string>): string[] {
  const env: Record<string, string> = {
    ENGINE_TRANSPORT: 'redis',
    TURN_ID: turnId,
    REDIS_URL: REDIS_URL_CONTAINER,
    AGENT_HOME_ROOT: '/atlas-home',
    ...(extraEnv ?? {}),
  };
  const args: string[] = ['exec'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push('-w', '/workspace');
  return args;
}

export function kickEngine(
  sandbox: string,
  turnId: string,
  opts: KickOptions = {},
): ChildProcess | null {
  const args = [...kickEnvArgs(turnId, opts.extraEnv), sandbox, 'atlas-engine-turn'];
  if (opts.detached) {
    const child = spawn('docker', args, {
      stdio: ['ignore', opts.quiet ? 'ignore' : 'inherit', 'inherit'],
      detached: true,
    });
    child.unref();
    return child;
  }
  try {
    execFileSync('docker', args, {
      stdio: ['ignore', opts.quiet ? 'ignore' : 'inherit', 'inherit'],
      timeout: opts.timeoutMs ?? 180_000,
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (typeof status !== 'number') {
      throw new Error(`docker exec failed to run for turn ${turnId} (redacted)`);
    }
  }
  return null;
}

export function kickAwaitExit(
  sandbox: string,
  turnId: string,
  timeoutMs = 20_000,
): Promise<{ code: number | null; spawnError: boolean }> {
  const args = [...kickEnvArgs(turnId), sandbox, 'atlas-engine-turn'];
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, spawnError: false });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, spawnError: true });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, spawnError: false });
    });
  });
}

export interface TailResult {
  frames: Frame[];
  final?: Frame;
  error?: Frame;
  lastId: string;
  timedOut: boolean;
}

export async function tailEvents(
  redis: Redis,
  turnId: string,
  opts: { timeoutMs?: number; fromId?: string; onFrame?: (f: Frame, id: string) => void } = {},
): Promise<TailResult> {
  const { events } = turnKeys(turnId);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let lastId = opts.fromId ?? '0-0';
  const frames: Frame[] = [];
  let final: Frame | undefined;
  let error: Frame | undefined;
  const t0 = Date.now();
  while (!final && !error && Date.now() - t0 < timeoutMs) {
    const r = (await redis
      .xread('BLOCK', 1000, 'STREAMS', events, lastId)
      .catch(() => null)) as Array<[string, Array<[string, string[]]>]> | null;
    if (!r) continue;
    for (const [, entries] of r) {
      for (const [id, f] of entries) {
        lastId = id;
        const fr = decode(f);
        if (!fr) continue;
        frames.push(fr);
        opts.onFrame?.(fr, id);
        if (fr.t === 'final') final = fr;
        else if (fr.t === 'error') error = fr;
      }
    }
  }
  return { frames, final, error, lastId, timedOut: !final && !error };
}

export function frameKinds(frames: Frame[]): string {
  return frames
    .map((f) => (f.t === 'event' ? `event:${(f.e as { kind?: string })?.kind}` : String(f.t)))
    .join(' ');
}

export function events(frames: Frame[]): Array<Record<string, unknown>> {
  return frames.filter((f) => f.t === 'event').map((f) => f.e as Record<string, unknown>);
}

export function finalResult(final: Frame | undefined): string {
  const r = final?.r as { result?: unknown } | undefined;
  return typeof r?.result === 'string' ? r.result : '';
}

export async function cleanup(redis: Redis, turnId: string): Promise<void> {
  const k = turnKeys(turnId);
  await redis.del(k.spec, k.events, k.tools, k.replies, k.input).catch(() => undefined);
}

export function newTurnId(): string {
  return randomUUID();
}

export const TOOLS_GROUP = 'host';

export interface ToolResponder {
  stop: () => void;
  done: Promise<void>;
  called: string[];
}

export function startToolResponder(
  redis: Redis,
  turnId: string,
  opts: {
    onRequest: (req: {
      id: string;
      name: string;
      args: unknown;
    }) => { result: unknown } | { error: string } | null;
    heartbeat?: boolean;
  },
): ToolResponder {
  const { tools, replies } = turnKeys(turnId);
  const conn = redis.duplicate();
  const called: string[] = [];
  let stopped = false;
  const done = (async () => {
    await conn.xgroup('CREATE', tools, TOOLS_GROUP, '0', 'MKSTREAM').catch(() => undefined);
    while (!stopped) {
      const r = (await conn
        .xreadgroup('GROUP', TOOLS_GROUP, 'c1', 'COUNT', 10, 'BLOCK', 500, 'STREAMS', tools, '>')
        .catch(() => null)) as Array<[string, Array<[string, string[]]>]> | null;
      if (!r) continue;
      for (const [, entries] of r) {
        for (const [id, f] of entries) {
          const req = decode(f) as { t?: string; id: string; name: string; args: unknown } | null;
          if (req?.t === 'tool_request') {
            called.push(req.name);
            if (opts.heartbeat) {
              await xadd(redis, replies, { t: 'tool_progress', id: req.id, ts: Date.now() });
            }
            const ans = opts.onRequest({ id: req.id, name: req.name, args: req.args });
            if (ans && 'result' in ans) {
              await xadd(redis, replies, { t: 'tool_response', id: req.id, result: ans.result });
            } else if (ans && 'error' in ans) {
              await xadd(redis, replies, { t: 'tool_error', id: req.id, message: ans.error });
            }
          }
          await conn.xack(tools, TOOLS_GROUP, id).catch(() => undefined);
        }
      }
    }
    conn.disconnect();
  })();
  return { stop: () => (stopped = true), done, called };
}

export function killEngineIn(sandbox: string): void {
  try {
    execFileSync('docker', ['exec', sandbox, 'pkill', '-f', 'engine-app.js'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {}
}

export function requireSandboxArg(script: string): string {
  const sbx = process.argv[2];
  if (!sbx) {
    console.error(`usage: npx tsx src/engine/__e2e__/${script} <sandboxContainerId>`);
    process.exit(2);
  }
  return sbx;
}

export function report(tag: string, pass: boolean, detail?: string): never {
  console.log(`[${tag}] RESULT: ${pass ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
  process.exit(pass ? 0 : 1);
}
