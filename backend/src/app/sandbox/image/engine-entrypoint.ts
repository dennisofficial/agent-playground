/**
 * The in-container engine entrypoint. Bundled by esbuild into `engine-entrypoint.mjs`, baked into the
 * sandbox image, and invoked by the host's `RedisEngineRunner` via a DETACHED `docker exec atlas-engine-turn`.
 *
 * REDIS TRANSPORT (the only transport — the former stdin/stdout pipe was removed at the cutover, ADR 0001):
 *   - the host XADDs the turn spec to `turn:{T}:spec`; we read it on startup (TURN_ID + REDIS_URL via env).
 *   - we append `{t:'event', e}` per progress event + periodic `{t:'heartbeat'}` to `turn:{T}:events`,
 *     then a single `{t:'final', r}` (or `{t:'error', message}`).
 *   - TOOL BRIDGE: a thin `createSdkMcpServer` whose handlers XADD `{t:'tool_request', id, name, args}` to
 *     `turn:{T}:tools` and await the host's `{t:'tool_response'|'tool_error', id, …}` on `turn:{T}:replies`
 *     (correlated by `id`). Because the streams are durable, a backend restart re-attaches and resumes.
 *
 * It reuses the SAME {@link EngineCore} as everything else (esbuild bundles it + ioredis in). Credentials
 * are passed as exec env, never baked into the image.
 */
import { randomUUID } from 'node:crypto';
import { EngineCore } from '../../engine/engine-core';
import type { EngineEvent, RunEngineArgs } from '../../engine/engine.types';
import { BRIDGE_SERVER_NAME, buildBridgeClaudeOptions, type BridgeClaudeOptions } from './bridge-options';

/** The serialized turn — everything `RunEngineArgs` carries except host-only, non-serializable bits. */
type TurnSpec = Omit<RunEngineArgs, 'onEvent' | 'signal' | 'target' | 'toolBridge'> & {
  /** When present, activates the tool bridge — the list of host tool names to proxy via an MCP server. */
  toolBridgeTools?: string[];
};

/** The host's reply frame on `turn:{T}:replies` (correlated to a tool_request by `id`). */
type HostFrame =
  | { t: 'tool_response'; id: string; result: unknown }
  | { t: 'tool_error'; id: string; message: string };

/**
 * REDIS TRANSPORT (`ENGINE_TRANSPORT=redis`, additive): instead of stdin/stdout the engine reads its
 * spec from `turn:{T}:spec` and appends event frames to `turn:{T}:events` (+ periodic heartbeats), so
 * the turn survives a host restart (the host re-attaches to the durable stream). The tool-bridge runs
 * over `turn:{T}:tools` (engine→host requests) + `turn:{T}:replies` (host→engine responses). Mirrors the
 * pipe path's frame shapes exactly so the host runner is transport-symmetric.
 */
async function runOverRedis(turnId: string): Promise<void> {
  const { Redis } = await import('ioredis');
  const url = process.env.REDIS_URL ?? 'redis://redis:6379';
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  const eventsKey = `turn:${turnId}:events`;
  const toolsKey = `turn:${turnId}:tools`;
  const repliesKey = `turn:${turnId}:replies`;
  const xadd = (stream: string, frame: unknown): Promise<unknown> =>
    client.xadd(stream, '*', 'data', JSON.stringify(frame));

  // A periodic heartbeat so the host watchdog can tell a live (but quiet) turn from a dead engine.
  const heartbeat = setInterval(() => {
    void xadd(eventsKey, { t: 'heartbeat', ts: Date.now() }).catch(() => undefined);
  }, 5_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  let stopReplies: (() => void) | undefined;
  let sub: typeof client | undefined; // the tool-bridge replies-reader connection (must be closed)

  try {
    // The spec is a single-entry stream the host XADDed before the kick.
    const specEntries = (await client.xread('COUNT', 1, 'STREAMS', `turn:${turnId}:spec`, '0')) as
      | Array<[string, Array<[string, string[]]>]>
      | null;
    const fields = specEntries?.[0]?.[1]?.[0]?.[1] ?? [];
    const dataIdx = fields.indexOf('data');
    if (dataIdx < 0) throw new Error(`engine-entrypoint: no spec for turn ${turnId}`);
    const spec = JSON.parse(fields[dataIdx + 1]) as TurnSpec;

    const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
    const codexSdk = await import('@openai/codex-sdk');
    const core = new EngineCore(
      claudeSdk,
      codexSdk,
      {
        homeRoot: process.env.AGENT_HOME_ROOT,
        claudeOauthToken: process.env.CLAUDE_OAUTH_TOKEN,
        codexOauthToken: process.env.CODEX_OAUTH_TOKEN,
      },
      { warn: (m) => process.stderr.write(`[engine-core] ${m}\n`) },
    );

    // ── Tool bridge over Redis (additive) ──────────────────────────────────────────────────────
    let bridge: BridgeClaudeOptions | undefined;
    if (spec.toolBridgeTools && spec.toolBridgeTools.length > 0) {
      const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
      // A SEPARATE connection blocks on the replies stream (a blocking read can't share the main client).
      sub = client.duplicate();
      let stop = false;
      stopReplies = () => {
        stop = true;
      };
      const subConn = sub;
      void (async () => {
        let lastId = '0-0';
        while (!stop) {
          const r = (await subConn.xread('BLOCK', 1000, 'STREAMS', repliesKey, lastId)) as
            | Array<[string, Array<[string, string[]]>]>
            | null;
          if (!r) continue;
          for (const [, entries] of r) {
            for (const [eid, f] of entries) {
              lastId = eid;
              const di = f.indexOf('data');
              if (di < 0) continue;
              const frame = JSON.parse(f[di + 1]) as HostFrame;
              const entry = pending.get(frame.id);
              if (!entry) continue;
              pending.delete(frame.id);
              if (frame.t === 'tool_response') entry.resolve(frame.result);
              else entry.reject(new Error(frame.message));
            }
          }
        }
      })().catch(() => undefined);

      const z = (await import('zod/v4')).z;
      const mcpTools = spec.toolBridgeTools.map((toolName: string) =>
        claudeSdk.tool(
          toolName,
          `Host-side tool '${toolName}' proxied via the Atlas tool bridge.`,
          { args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments') },
          async (input: { args?: Record<string, unknown> }) => {
            const id = randomUUID();
            const resultPromise = new Promise<unknown>((resolve, reject) => {
              pending.set(id, { resolve, reject });
            });
            await xadd(toolsKey, { t: 'tool_request', id, name: toolName, args: input.args ?? {} });
            try {
              const result = await resultPromise;
              const text = typeof result === 'string' ? result : JSON.stringify(result);
              return { content: [{ type: 'text' as const, text }] };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
            }
          },
        ),
      );
      const server = claudeSdk.createSdkMcpServer({
        name: BRIDGE_SERVER_NAME,
        version: '1.0.0',
        instructions: 'Atlas host tools. Call these to interact with the host harness.',
        tools: mcpTools,
        alwaysLoad: true,
      });
      bridge = buildBridgeClaudeOptions(server, spec.toolBridgeTools);
    }

    const runArgs: RunEngineArgs = {
      ...spec,
      onEvent: (e: EngineEvent) => void xadd(eventsKey, { t: 'event', e }).catch(() => undefined),
    };
    const result = await core.runWithExtras(
      runArgs,
      bridge?.extraClaudeOptions,
      bridge?.bridgeToolNames,
    );
    await xadd(eventsKey, { t: 'final', r: result });
  } catch (err) {
    const e = err as { isAuthError?: boolean; sessionId?: string; stack?: string; message?: string };
    await xadd(eventsKey, {
      t: 'error',
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      ...(e?.isAuthError ? { auth: true } : {}),
      ...(typeof e?.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
    }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    stopReplies?.();
    clearInterval(heartbeat);
    sub?.disconnect(); // the replies-reader's separate connection — leaks the process if left open
    client.disconnect();
  }
}

async function main(): Promise<void> {
  // Redis is the only transport: the host kicks us DETACHED with TURN_ID + REDIS_URL; we read the spec
  // from `turn:{T}:spec` and write events to `turn:{T}:events` (the tool bridge rides the tools/replies
  // streams). See ADR 0001.
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('engine-entrypoint: TURN_ID is required (Redis transport)');
  await runOverRedis(turnId);
  // Force a clean exit — the SDK/ioredis can leave lingering handles that would hang this one-shot.
  process.exit(process.exitCode ?? 0);
}

main().catch((err: unknown) => {
  // runOverRedis reports turn failures over Redis itself; this only fires if it threw before connecting.
  process.stderr.write(
    `[engine-entrypoint] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
