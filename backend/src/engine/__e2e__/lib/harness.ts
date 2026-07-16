// Shared helpers for the engine e2e scenarios. STANDALONE by design: imports only `ioredis` + node
// builtins (never repo code), so `tsx` runs a scenario with no path-alias / project plumbing. The wire
// shapes below MIRROR `@shared/engine/engine.types` (TurnSpec) and `@shared/engine/redis-turn-keys` — they
// are deliberately re-declared here rather than imported, exactly like the manual smoke scripts these
// port from, so the harness stays decoupled from the app build.
//
// These drive REAL turns against a REAL Docker sandbox + REAL Redis. The engine reads its subscription
// auth from the turn SPEC (`spec.auth`), not from env (the new NestJS engine has no ambient-token
// fallback), so `makeSpec` threads `authFromEnv()` onto every spec — unlike the pre-rewrite smoke
// scripts, which relied on a `CLAUDE_OAUTH_TOKEN` env fallback that no longer exists.

import Redis from 'ioredis';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ScenarioResult {
  pass: boolean;
  detail: string;
}
/** A scenario: drive one behavior against `sandbox`, return PASS/FAIL + a one-line detail. */
export type Scenario = (sandbox: string) => Promise<ScenarioResult>;

/** Host-side Redis (the atlas-redis container publishes 6379 → host 6380). */
export const REDIS_URL_HOST = 'redis://127.0.0.1:6380';
/** The SAME Redis as the sandbox reaches it: the container shares the `atlas-redis` docker network
 *  (alias `redis`, port 6379). Overridable via E2E_SANDBOX_REDIS_URL for a differently-wired host. */
export const REDIS_URL_CONTAINER =
  process.env.E2E_SANDBOX_REDIS_URL ?? 'redis://redis:6379';
/** Hard requirement for live validation: every scenario pins Haiku for cost control. */
export const HAIKU = 'claude-haiku-4-5-20251001';

export type Frame = Record<string, unknown> & { t?: string };

/** One turn's Redis key namespace — mirrors `@shared/engine/redis-turn-keys.ts`. */
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

/** XADD one JSON frame under the single `data` field the engine's decoder expects. */
export function xadd(redis: Redis, stream: string, frame: unknown): Promise<string> {
  return redis.xadd(stream, '*', 'data', JSON.stringify(frame)) as Promise<string>;
}

/** Decode a stream entry's fields (`['data', '<json>']`) back into a frame, or null if unparseable. */
export function decode(fields: string[]): Frame | null {
  const i = fields.indexOf('data');
  if (i < 0) return null;
  try {
    return JSON.parse(fields[i + 1]) as Frame;
  } catch {
    return null;
  }
}

/**
 * The subscription auth every turn spec carries. The engine's `EngineCore.resolveAuth` THROWS when a
 * turn has no explicit auth (no env fallback), so this is required for any turn expected to run. A plain
 * OAuth token string is a `setup-token` (kind omitted → delivered as `CLAUDE_CODE_OAUTH_TOKEN`); a JSON
 * `{claudeAiOauth:{accessToken}}` blob is a `personal` login (written as `.credentials.json`).
 */
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
  } catch {
    /* not JSON → a plain setup-token */
  }
  return { secret };
}

export interface SpecOverrides {
  task?: string;
  systemPrompt?: string;
  mode?: 'plan' | 'review' | 'execute';
  steerable?: boolean;
  richStream?: boolean;
  toolBridgeTools?: string[];
  /** Set false to build a spec WITHOUT auth (drives the deterministic no-credential error path). */
  auth?: false;
  homeType?: 'brain' | 'build' | 'plan-review' | 'autofix' | 'review';
  [k: string]: unknown;
}

/**
 * Build a wire `TurnSpec` (a hand-mirrored projection of `@shared/engine/engine.types` `TurnSpec`).
 * `sandboxKey` is the STRUCTURED `EngineHomeKey` the new engine requires (a plain string crashes
 * `atlasEngineHomeDir`); a distinct per-turn jobId keeps each scenario off the sandbox's real session.
 */
export function makeSpec(turnId: string, o: SpecOverrides = {}): Record<string, unknown> {
  const { task, systemPrompt, mode, steerable, richStream, toolBridgeTools, auth, homeType, ...rest } = o;
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
  /** Detached (unref'd) — the engine keeps running independently of this script (restart-survival shape). */
  detached?: boolean;
  /** Extra/override exec env merged onto the standard redis-transport env. */
  extraEnv?: Record<string, string>;
  /** Pipe the engine's stdio to this process (default) or silence it. */
  quiet?: boolean;
  /** Blocking-kick timeout before the exec is killed. */
  timeoutMs?: number;
}

// SECRET SAFETY: the OAuth token is NOT put in the exec env / argv — the new engine reads its auth from
// `spec.auth` (XADDed to Redis), never from `CLAUDE_OAUTH_TOKEN`. Keeping the token out of argv means it
// can never leak through `docker`'s process list or an exec error message (which echoes the full argv).
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

/**
 * `docker exec … atlas-engine-turn` inside `sandbox`. Detached → returns the ChildProcess (unref'd, the
 * engine outlives this script). Blocking → waits for the exec to exit, but SWALLOWS a non-zero exit code
 * (the engine reports turn failures via the terminal `error` FRAME + exit 1, which the caller reads from
 * Redis — the code itself is not the signal here), and re-throws only a REDACTED error so no argv leaks.
 */
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
    // Non-zero exit = a turn that ended in an error frame (read from Redis) — swallow. Re-throw only a
    // redacted marker (never `e`, whose `.message` contains the full argv) so a real spawn failure surfaces.
    const status = (e as { status?: number }).status;
    if (typeof status !== 'number') {
      throw new Error(`docker exec failed to run for turn ${turnId} (redacted)`);
    }
  }
  return null;
}

/**
 * Spawn `docker exec … atlas-engine-turn` and RESOLVE with how it exited — for the bogus-container probe,
 * which asserts the HOST-side exec fails FAST. Never rejects with the raw error (argv redaction); a
 * spawn-level failure resolves as `{ code: null, spawnError: true }`.
 */
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

/**
 * Tail `turn:{T}:events` from `fromId` until a `final`/`error` frame or `timeoutMs`. Returns every frame
 * seen plus the terminal one. Uses a plain blocking XREAD (no consumer group) — the engine writes the
 * durable log; a fresh reader from any cursor gets the rest, which is exactly the reattach property.
 */
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

/** The human-readable frame sequence, e.g. `event:session event:text event:result final`. */
export function frameKinds(frames: Frame[]): string {
  return frames
    .map((f) => (f.t === 'event' ? `event:${(f.e as { kind?: string })?.kind}` : String(f.t)))
    .join(' ');
}

/** The `EngineEvent`s carried by `{t:'event', e}` frames. */
export function events(frames: Frame[]): Array<Record<string, unknown>> {
  return frames
    .filter((f) => f.t === 'event')
    .map((f) => f.e as Record<string, unknown>);
}

/** The `final` frame's result string (`final.r.result`), or ''. */
export function finalResult(final: Frame | undefined): string {
  const r = final?.r as { result?: unknown } | undefined;
  return typeof r?.result === 'string' ? r.result : '';
}

/** Delete every stream this turn may have created. Host-owned cleanup — the engine never deletes them. */
export async function cleanup(redis: Redis, turnId: string): Promise<void> {
  const k = turnKeys(turnId);
  await redis.del(k.spec, k.events, k.tools, k.replies, k.input).catch(() => undefined);
}

export function newTurnId(): string {
  return randomUUID();
}

/** The host consumer group the engine expects to drain `turn:{T}:tools` (mirrors `TOOLS_GROUP`). */
export const TOOLS_GROUP = 'host';

export interface ToolResponder {
  stop: () => void;
  done: Promise<void>;
  /** Tool names the engine actually invoked, in order. */
  called: string[];
}

/**
 * Stand in for the host tool-bridge dispatcher (mirrors `RedisEngineRunner.consumeTools`): drain
 * `turn:{T}:tools` via the `host` consumer group and answer each `tool_request` on `turn:{T}:replies`.
 * `onRequest` returns `{ result }` / `{ error }`, or `null` to deliberately stay SILENT (never reply —
 * for the byzantine-host adversarial case). `heartbeat:true` emits the immediate `tool_progress` a real
 * host sends on pickup (arms the in-container idle timer); omit it to simulate a host that never beats.
 */
export function startToolResponder(
  redis: Redis,
  turnId: string,
  opts: {
    onRequest: (req: { id: string; name: string; args: unknown }) =>
      | { result: unknown }
      | { error: string }
      | null;
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
            // ans === null → stay silent (no reply, no heartbeat): the byzantine-host case.
          }
          await conn.xack(tools, TOOLS_GROUP, id).catch(() => undefined);
        }
      }
    }
    conn.disconnect();
  })();
  return { stop: () => (stopped = true), done, called };
}

/** Kill any lingering in-container engine process (cleanup after a deliberately-hung adversarial turn). */
export function killEngineIn(sandbox: string): void {
  try {
    execFileSync('docker', ['exec', sandbox, 'pkill', '-f', 'engine-app.js'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    /* nothing to kill / pkill absent — fine */
  }
}

/** Parse the required `<sandboxContainerId>` CLI arg, or exit(2) with usage. */
export function requireSandboxArg(script: string): string {
  const sbx = process.argv[2];
  if (!sbx) {
    console.error(`usage: npx tsx src/engine/__e2e__/${script} <sandboxContainerId>`);
    process.exit(2);
  }
  return sbx;
}

/** Standard PASS/FAIL log + exit for a single scenario run directly. */
export function report(tag: string, pass: boolean, detail?: string): never {
  console.log(
    `[${tag}] RESULT: ${pass ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`,
  );
  process.exit(pass ? 0 : 1);
}
