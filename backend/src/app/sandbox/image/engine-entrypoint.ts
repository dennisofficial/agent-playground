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
import type { EngineEvent, RunEngineArgs, TurnSpec } from '../../engine/engine.types';
import { BRIDGE_SERVER_NAME, buildBridgeClaudeOptions, type BridgeClaudeOptions } from './bridge-options';
import {
  WORKSPACE_PROFILE_BRIDGE_NAME,
  partitionWorkspaceProfileTools,
  qualifyWorkspaceProfileToolNames,
} from './workspace-profile-bridge-options';
import { buildLspBridgeOptions } from './lsp-bridge-options';
import { buildContext7BridgeOptions } from './context7-bridge-options';
import { buildUserMcpBridgeOptions } from './user-mcp-bridge-options';
import { ToolBridgeReader } from './tool-bridge-reader';
import { TOOL_SHAPES, TOOL_DESCRIPTIONS } from './host-tool-schemas';

// `TurnSpec` is the SINGLE host↔engine wire contract — imported from engine.types (the same type the host's
// `redis-engine-runner.buildSpec` produces), NOT re-declared here, so producer + consumer can never drift.

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

  let reader: ToolBridgeReader | undefined;
  let sub: typeof client | undefined; // the tool-bridge replies-reader's CURRENT connection (must be closed)
  let stopInput: (() => void) | undefined;
  let inputSub: typeof client | undefined; // the steering input-reader connection (must be closed)
  let abortSub: typeof client | undefined; // the abort pub/sub connection (must be closed)

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
      // Engine subscription auth arrives per-turn as the spec's explicit `args.auth` (resolved per-org on
      // the host) — never from ambient env, so no oauth tokens are threaded into the core config here.
      {
        homeRoot: process.env.AGENT_HOME_ROOT,
        skillsRoot: process.env.SKILLS_ROOT,
        managedSkillsRoot: process.env.SKILLS_MANAGED_ROOT,
        managedGitSkillsRoot: process.env.SKILLS_MANAGED_GIT_ROOT,
      },
    );

    // ── Tool bridge over Redis (additive) ──────────────────────────────────────────────────────
    // CLAUDE ONLY: builds in-process SDK MCP tools + runs the reply-reader here. A Codex turn instead
    // spawns the standalone `mcp-bridge-server.mjs` (declared in config.toml by `runCodex`), which runs
    // its OWN reply-reader — so we must NOT also run one here for Codex (two readers would race for the
    // same `turn:{T}:replies` stream).
    let bridge: BridgeClaudeOptions | undefined;
    let workspaceProfileBridge: BridgeClaudeOptions | undefined;
    if (spec.engine === 'claude' && spec.toolBridgeTools && spec.toolBridgeTools.length > 0) {
      // The shared reader owns its own blocking connection (a blocking read can't share the main
      // client) and swaps it internally on a stall-reset; `makeSub` also assigns the outer `sub` so the
      // `finally` cleanup below always disconnects whichever connection is CURRENT.
      reader = new ToolBridgeReader({
        repliesKey,
        makeSub: () => {
          sub = client.duplicate();
          return sub;
        },
        log: (m) => process.stderr.write(`[engine-entrypoint] ${m}\n`),
      });
      reader.start();
      const toolReader = reader;

      // One proxy per tool — identical transport (XADD a `tool_request` by BARE name); which server
      // it is registered under is purely presentational. Reused for both bridges below. Each tool
      // registers its REAL per-tool shape from the shared canonical source, so the SDK's strict object
      // validates + strips the model's input and the flat parsed payload forwards straight through.
      const makeProxyTool = (toolName: string) => {
        const shape = TOOL_SHAPES[toolName];
        if (!shape) {
          // Fail loud: an empty shape would be wrapped in the SDK's STRICT object and silently strip
          // the whole payload to `{}` before the handler runs. A missing schema is a drift bug (caught
          // by the completeness guard tests) — surface it here rather than at runtime as data loss.
          throw new Error(`[engine-entrypoint] no TOOL_SHAPES entry for bridged tool '${toolName}'`);
        }
        return claudeSdk.tool(
          toolName,
          TOOL_DESCRIPTIONS[toolName] ?? `Host-side tool '${toolName}' proxied via the Atlas tool bridge.`,
          shape,
          async (input: Record<string, unknown>) => {
            const id = randomUUID();
            const resultPromise = toolReader.register(id);
            try {
              await xadd(toolsKey, { t: 'tool_request', id, name: toolName, args: input ?? {} });
            } catch (err) {
              toolReader.cancel(id);
              throw err;
            }
            try {
              const result = await resultPromise;
              const text = typeof result === 'string' ? result : JSON.stringify(result);
              return { content: [{ type: 'text' as const, text }] };
            } catch (err) {
              const message = (err instanceof Error ? err.message : String(err)) || 'host tool error (no message)';
              return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
            }
          },
        );
      };
      // Split the flat host tool list into the general host bridge and the dedicated Workspace
      // Profile bridge, so the brain sees the seven provisioning dimensions as one section.
      const { host: hostToolNames, profile: profileToolNames } = partitionWorkspaceProfileTools(
        spec.toolBridgeTools,
      );
      const server = claudeSdk.createSdkMcpServer({
        name: BRIDGE_SERVER_NAME,
        version: '1.0.0',
        instructions: 'Atlas host tools. Call these to interact with the host harness.',
        tools: hostToolNames.map(makeProxyTool),
        alwaysLoad: true,
      });
      bridge = buildBridgeClaudeOptions(server, hostToolNames);
      if (profileToolNames.length > 0) {
        const profileServer = claudeSdk.createSdkMcpServer({
          name: WORKSPACE_PROFILE_BRIDGE_NAME,
          version: '1.0.0',
          instructions:
            'Atlas Workspace Profile — provision and maintain this repo\'s durable workspace: secret files, mounts, setup script, MCP servers, skills, and house style.',
          tools: profileToolNames.map(makeProxyTool),
          alwaysLoad: true,
        });
        workspaceProfileBridge = {
          extraClaudeOptions: { mcpServers: { [WORKSPACE_PROFILE_BRIDGE_NAME]: profileServer } },
          bridgeToolNames: qualifyWorkspaceProfileToolNames(profileToolNames),
        };
      }
    }

    // ── LSP bridge (atlas-lsp-ts, external stdio MCP server) ────────────────────────────────────
    // Unlike the host bridge above, the SDK spawns this process itself — no Redis round-trip. See
    // lsp-bridge-options.ts for why it's gated to execute-mode turns and confined to `spec.cwd`.
    const lsp = buildLspBridgeOptions(spec.mode, spec.cwd);

    // ── Context7 docs bridge (remote HTTP MCP server) ───────────────────────────────────────────
    // Version-pinned library docs for the `docs` subagent. OFF unless CONTEXT7_API_KEY is in the
    // container env; execute-mode only (same gate as the LSP bridge). See context7-bridge-options.ts.
    const context7 = buildContext7BridgeOptions(spec.mode);

    // ── User-defined MCP servers (org/repo tiers, resolved host-side) ────────────────────────────
    // Whatever `McpResolver` picked for this turn's org/repo/surface (secrets already inlined). No mode
    // gate — the host already filtered by surface. Claude gets every server; Codex gets the stdio ones.
    // See user-mcp-bridge-options.ts.
    const userMcp = buildUserMcpBridgeOptions(spec.userMcpServers);

    // ── Mid-turn steering + cooperative stop (the operator-facing brain turn) ───────────────────
    // Only wired when the host marked the turn `steerable`. The abort channel (pub/sub) cancels the SDK
    // query; the input channel (a durable stream) feeds operator steers into the live turn.
    const abortController = new AbortController();
    let steerInput: AsyncIterable<{ id?: string; text: string }> | undefined;
    if (spec.steerable) {
      abortSub = client.duplicate();
      await abortSub.subscribe(`turn:${turnId}:abort`);
      abortSub.on('message', () => abortController.abort());

      const inputKey = `turn:${turnId}:input`;
      const conn = client.duplicate();
      inputSub = conn;
      let stopped = false;
      stopInput = () => {
        stopped = true;
      };
      steerInput = {
        async *[Symbol.asyncIterator]() {
          // '0-0' reads every steer from the start of THIS turn's fresh input stream (no missed-race, no
          // stale data). BLOCK yields control between polls so the loop unwinds promptly once stopped.
          let lastId = '0-0';
          while (!stopped) {
            const r = (await conn.xread('BLOCK', 1000, 'STREAMS', inputKey, lastId)) as
              | Array<[string, Array<[string, string[]]>]>
              | null;
            if (!r) continue;
            for (const [, entries] of r) {
              for (const [eid, f] of entries) {
                lastId = eid;
                const di = f.indexOf('data');
                if (di < 0) continue;
                const frame = JSON.parse(f[di + 1]) as { id?: string; text?: string };
                if (typeof frame.text === 'string' && frame.text.length > 0)
                  yield { ...(typeof frame.id === 'string' ? { id: frame.id } : {}), text: frame.text };
              }
            }
          }
        },
      };
    }

    const runArgs: RunEngineArgs = {
      ...spec,
      onEvent: (e: EngineEvent) => void xadd(eventsKey, { t: 'event', e }).catch(() => undefined),
      ...(spec.steerable ? { signal: abortController.signal, steerInput } : {}),
    };
    // `extraClaudeOptions`/bridge tool names are each a SINGLE object/array spread verbatim into the SDK
    // Options (see bridge-options.ts) — so the host bridge's and the LSP bridge's `mcpServers` must be
    // merged into ONE object here, not passed as two separate `extraClaudeOptions`.
    const mergedMcpServers = {
      ...(bridge?.extraClaudeOptions.mcpServers ?? {}),
      ...(workspaceProfileBridge?.extraClaudeOptions.mcpServers ?? {}),
      ...(lsp?.extraClaudeOptions.mcpServers ?? {}),
      ...(context7?.extraClaudeOptions.mcpServers ?? {}),
      ...(userMcp?.extraClaudeOptions.mcpServers ?? {}),
    };
    const mergedToolNames = [
      ...(bridge?.bridgeToolNames ?? []),
      ...(workspaceProfileBridge?.bridgeToolNames ?? []),
      ...(lsp?.lspToolNames ?? []),
      ...(context7?.context7ToolNames ?? []),
      ...(userMcp?.userMcpToolNames ?? []),
    ];
    // For a Codex execute turn, hand the BARE bridge tool names to `runCodex` — it renders them into the
    // config.toml `[mcp_servers.atlasbridge]` block (the Codex tool bridge). Claude uses the merged Claude
    // options above instead; the two engines never both consume the bridge on one turn.
    const codexBridgeTools =
      spec.engine === 'codex' && spec.toolBridgeTools && spec.toolBridgeTools.length > 0
        ? spec.toolBridgeTools
        : undefined;
    // For a Codex execute turn, the user's stdio MCP servers ride in as config.toml `[mcp_servers.*]`
    // blocks (Codex ignores the Claude `mcpServers` above). Same command/args/env as the Claude side.
    const codexExtraMcpServers =
      spec.engine === 'codex'
        ? {
            ...(userMcp?.codexExtraMcpServers ?? {}),
          }
        : undefined;
    const result = await core.runWithExtras(
      runArgs,
      Object.keys(mergedMcpServers).length > 0 ? { mcpServers: mergedMcpServers } : undefined,
      mergedToolNames.length > 0 ? mergedToolNames : undefined,
      codexBridgeTools,
      codexExtraMcpServers,
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
    reader?.stopReader();
    stopInput?.();
    clearInterval(heartbeat);
    sub?.disconnect(); // the replies-reader's separate connection — leaks the process if left open
    inputSub?.disconnect(); // the steering input-reader's separate connection
    abortSub?.disconnect(); // the abort pub/sub connection
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
