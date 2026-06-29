/**
 * The in-container engine entrypoint (D1, R1-extended). Bundled by esbuild into
 * `engine-entrypoint.mjs`, baked into the sandbox image, and invoked by the host's
 * `DockerEngineRunner` via `docker exec atlas-engine-turn`.
 *
 * Protocol (BASELINE — one-shot, unchanged):
 *   - stdin: one JSON `TurnSpec` (a serialized `RunEngineArgs` minus the host-only callbacks).
 *   - stdout: NDJSON frames — `{t:'event', e:EngineEvent}` per progress event, then a single
 *     `{t:'final', r:EngineRunResult}` (or `{t:'error', message}` on failure).
 *   - stderr: diagnostics only (kept off stdout so the NDJSON stays parseable).
 *
 * Protocol (TOOL-BRIDGE — new, additive, R1):
 *   When `spec.toolBridgeTools` is present (a list of tool names the host exposes), stdin stays
 *   open after the initial spec. The entrypoint hosts a thin `createSdkMcpServer` (from
 * `@anthropic-ai/claude-agent-sdk`) whose tool handlers proxy to the host via the bidirectional
 *   frame protocol:
 *     - entrypoint emits `{t:'tool_request', id, name, args}` on stdout
 *     - host replies `{t:'tool_response', id, result}` or `{t:'tool_error', id, message}` on stdin
 *     - correlation is by `id` (UUID generated in the entrypoint)
 *   The final frame (`{t:'final',...}`) is still the last thing emitted on stdout; after emitting
 *   it the entrypoint exits and the exec stream closes naturally.
 *
 * It reuses the SAME {@link EngineCore} as the host runner (esbuild bundles it in). Credentials are
 * passed as exec env, never baked into the image.
 */
import { randomUUID } from 'node:crypto';
import { EngineCore, type EngineCoreConfig } from '../../engine/engine-core';
import type { EngineEvent, EngineRunResult, RunEngineArgs } from '../../engine/engine.types';
import { BRIDGE_SERVER_NAME, buildBridgeClaudeOptions, type BridgeClaudeOptions } from './bridge-options';

/** The serialized turn — everything `RunEngineArgs` carries except host-only, non-serializable bits. */
type TurnSpec = Omit<RunEngineArgs, 'onEvent' | 'signal' | 'target' | 'toolBridge'> & {
  /**
   * When present, activates the tool bridge. Contains the list of tool names the host exposes.
   * The entrypoint creates a thin MCP server proxy for each tool.
   */
  toolBridgeTools?: string[];
};

/** Frames the host may write on stdin. */
type HostFrame =
  | { t: 'tool_response'; id: string; result: unknown }
  | { t: 'tool_error'; id: string; message: string };

function emit(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Read exactly ONE NDJSON line from stdin (the initial spec). In tool-bridge mode stdin stays
 * open for host-frame responses; in one-shot mode we consume all stdin then return.
 */
async function readFirstLine(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        // Got the first complete line — extract it and stop reading.
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('error', onError);
        resolve(buf.slice(0, nl).trim());
      }
    };
    const onError = (err: Error) => reject(err);
    // For one-shot mode (no newline in the spec) we need to handle end-of-stream too.
    const onEnd = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('error', onError);
      resolve(buf.trim());
    };
    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * In tool-bridge mode: reads pending host-frame lines from stdin, resolving the matching
 * pending promise. Runs as a background async loop for the duration of the turn.
 */
function startStdinFrameReader(
  pending: Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>,
): void {
  let buf = '';
  const drain = () => {
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let frame: HostFrame;
      try {
        frame = JSON.parse(line) as HostFrame;
      } catch {
        process.stderr.write(`[entrypoint] non-JSON stdin line: ${line}\n`);
        continue;
      }
      const entry = pending.get(frame.id);
      if (!entry) {
        process.stderr.write(`[entrypoint] unexpected frame id: ${frame.id}\n`);
        continue;
      }
      pending.delete(frame.id);
      if (frame.t === 'tool_response') {
        entry.resolve(frame.result);
      } else {
        entry.reject(new Error(frame.message));
      }
    }
  };

  process.stdin.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString('utf8');
    drain();
  });
  // Don't call process.stdin.resume() — it was already resumed by readFirstLine.
}

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
      const sub = client.duplicate();
      let stop = false;
      stopReplies = () => {
        stop = true;
      };
      void (async () => {
        let lastId = '0-0';
        while (!stop) {
          const r = (await sub.xread('BLOCK', 1000, 'STREAMS', repliesKey, lastId)) as
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
    client.disconnect();
  }
}

async function main(): Promise<void> {
  // Redis transport: the host kicks us detached with TURN_ID + ENGINE_TRANSPORT=redis; we read the spec
  // from / write events to Redis instead of stdin/stdout. See ADR 0001.
  const turnId = process.env.TURN_ID;
  if (process.env.ENGINE_TRANSPORT === 'redis' && turnId) {
    await runOverRedis(turnId);
    return;
  }

  const raw = await readFirstLine();
  if (!raw) throw new Error('engine-entrypoint: empty turn spec on stdin');
  const spec = JSON.parse(raw) as TurnSpec;

  const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
  const codexSdk = await import('@openai/codex-sdk');

  const cfg: EngineCoreConfig = {
    homeRoot: process.env.AGENT_HOME_ROOT,
    claudeOauthToken: process.env.CLAUDE_OAUTH_TOKEN,
    codexOauthToken: process.env.CODEX_OAUTH_TOKEN,
  };

  const core = new EngineCore(claudeSdk, codexSdk, cfg, {
    warn: (m) => process.stderr.write(`[engine-core] ${m}\n`),
  });

  // ── Build extra Claude options for the tool bridge ─────────────────────────────────────────
  let bridge: BridgeClaudeOptions | undefined;

  if (spec.toolBridgeTools && spec.toolBridgeTools.length > 0) {
    // A shared map: tool_request id → { resolve, reject }.  Populated by each tool call handler,
    // drained by the stdin reader loop.
    const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

    // Start reading host responses from stdin in the background.
    startStdinFrameReader(pending);

    // Build the thin MCP server: one tool per declared name that proxies via the frame protocol.
    const z = (await import('zod/v4')).z;
    const tools = spec.toolBridgeTools.map((toolName: string) =>
      claudeSdk.tool(
        toolName,
        `Host-side tool '${toolName}' proxied via the Atlas tool bridge.`,
        // Accept any JSON object as input (we forward it verbatim to the host).
        { args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments') },
        async (input: { args?: Record<string, unknown> }) => {
          const id = randomUUID();
          const resultPromise = new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
          });
          // Emit the tool_request on stdout.
          emit({ t: 'tool_request', id, name: toolName, args: input.args ?? {} });
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
      tools,
      alwaysLoad: true,
    });

    // Assemble the SDK option shape (`{ mcpServers }`) + the qualified tool names to auto-approve.
    bridge = buildBridgeClaudeOptions(server, spec.toolBridgeTools);
  }

  // ── Build the RunEngineArgs for EngineCore ────────────────────────────────────────────────
  const runArgs: RunEngineArgs = {
    ...spec,
    onEvent: (e: EngineEvent) => emit({ t: 'event', e }),
  };

  // Register the bridge MCP server under the SDK's `mcpServers` option and auto-approve its tools.
  const result: EngineRunResult = await core.runWithExtras(
    runArgs,
    bridge?.extraClaudeOptions,
    bridge?.bridgeToolNames,
  );
  emit({ t: 'final', r: result });
}

main().catch((err: unknown) => {
  const e = err as { isAuthError?: boolean; sessionId?: string; stack?: string; message?: string };
  emit({
    t: 'error',
    message: err instanceof Error ? (err.stack ?? err.message) : String(err),
    ...(e?.isAuthError ? { auth: true } : {}),
    ...(typeof e?.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
  });
  process.exitCode = 1;
});
