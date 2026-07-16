import { Injectable } from '@nestjs/common';
import { EngineCore } from '@shared/engine/engine-core';
import type {
  EngineEvent,
  RunEngineArgs,
} from '@shared/engine/engine.types';
import {
  BRIDGE_SERVER_NAME,
  buildBridgeClaudeOptions,
  type BridgeClaudeOptions,
} from '@shared/bridge-names/bridge-options';
import {
  WORKSPACE_PROFILE_BRIDGE_NAME,
  partitionWorkspaceProfileTools,
  qualifyWorkspaceProfileToolNames,
} from '@shared/bridge-names/workspace-profile-bridge-options';
import {
  ATLAS_PROD_BRIDGE_NAME,
  partitionAtlasProdTools,
  qualifyAtlasProdToolNames,
} from '@shared/bridge-names/atlas-prod-bridge-options';
import { TOOL_SHAPES, TOOL_DESCRIPTIONS } from '../app/sandbox/image/host-tool-schemas';
import { buildLspBridgeOptions } from './transport/bridges/lsp-bridge-options';
import { buildUserMcpBridgeOptions } from './transport/bridges/user-mcp-bridge-options';
import { TurnTransport } from './transport/turn-transport.service';
import { EngineEventBus } from './events/engine-events';

/**
 * Orchestrates ONE in-container turn: read the spec, run it to a terminal frame, finalize. This is the
 * body of the old `engine-entrypoint.ts:runOverRedis` MINUS the raw Redis calls (now {@link TurnTransport})
 * and MINUS the {@link EngineCore} internals (unchanged) — same bridges, same merge, same frames.
 *
 * `onEvent` publishes each event on {@link EngineEventBus} rather than calling `TurnTransport.emitEvent`
 * directly — `TurnEventForwarder` is the bus's sole subscriber and does that forwarding. Every OTHER
 * transport call here (`readSpec`/`startHeartbeat`/`openToolBridge`/`onAbort`/`readSteerInput`/`emitFinal`/
 * `emitError`) still goes straight through `TurnTransport`, unaffected by this. On failure it appends the
 * terminal `error` frame (verbatim from the entrypoint's catch) and RETHROWS, so `main.ts` maps the throw
 * to exit code 1 (the host runner reads that binary code).
 */
@Injectable()
export class TurnRunner {
  constructor(
    private readonly transport: TurnTransport,
    private readonly bus: EngineEventBus,
  ) {}

  async run(turnId: string): Promise<void> {
    try {
      const spec = await this.transport.readSpec(turnId);
      this.transport.startHeartbeat(turnId);

      const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
      const codexSdk = await import('@openai/codex-sdk');
      const core = new EngineCore(claudeSdk, codexSdk, {
        // Engine subscription auth arrives per-turn as `spec.auth` (resolved per-org on the host) —
        // never from ambient env, so no oauth tokens are threaded into the core config here.
        homeRoot: process.env.AGENT_HOME_ROOT,
        skillsRoot: process.env.SKILLS_ROOT,
        managedSkillsRoot: process.env.SKILLS_MANAGED_ROOT,
        managedGitSkillsRoot: process.env.SKILLS_MANAGED_GIT_ROOT,
      });

      // ── Tool bridge over Redis (CLAUDE ONLY) ──────────────────────────────────────────────────
      // A Codex turn instead spawns the standalone `mcp-bridge-server.mjs`, which runs its OWN
      // reply-reader — so we must NOT also open one here for Codex (two readers would race the replies).
      let bridge: BridgeClaudeOptions | undefined;
      let bridgeCall:
        | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
        | undefined;
      let workspaceProfileBridge: BridgeClaudeOptions | undefined;
      let atlasProdBridge: BridgeClaudeOptions | undefined;
      if (
        spec.engine === 'claude' &&
        spec.toolBridgeTools &&
        spec.toolBridgeTools.length > 0
      ) {
        const toolBridge = this.transport.openToolBridge(turnId);
        // Round-trip for host tools invoked OUTSIDE the model's tool list (e.g. the install-awareness
        // PostToolUse hook): raw host result, not an SDK tool-content envelope.
        bridgeCall = (name, args) => toolBridge.call(name, args);

        // One proxy per tool — identical transport (a `tool_request` by BARE name); which server it is
        // registered under is purely presentational. Each tool registers its REAL per-tool shape from
        // the shared canonical source so the SDK's strict object validates + forwards the flat payload.
        const makeProxyTool = (toolName: string) => {
          const shape = TOOL_SHAPES[toolName];
          if (!shape) {
            // Fail loud: an empty shape would be wrapped in the SDK's STRICT object and silently strip
            // the whole payload to `{}`. A missing schema is a drift bug — surface it, not data loss.
            throw new Error(
              `[turn-runner] no TOOL_SHAPES entry for bridged tool '${toolName}'`,
            );
          }
          return claudeSdk.tool(
            toolName,
            TOOL_DESCRIPTIONS[toolName] ??
              `Host-side tool '${toolName}' proxied via the Atlas tool bridge.`,
            shape,
            async (input: Record<string, unknown>) => {
              try {
                const result = await toolBridge.call(toolName, input ?? {});
                const text =
                  typeof result === 'string' ? result : JSON.stringify(result);
                return { content: [{ type: 'text' as const, text }] };
              } catch (err) {
                const message =
                  (err instanceof Error ? err.message : String(err)) ||
                  'host tool error (no message)';
                return {
                  content: [
                    { type: 'text' as const, text: `Error: ${message}` },
                  ],
                  isError: true,
                };
              }
            },
          );
        };
        // Split the flat host tool list into the general host bridge, the dedicated Workspace Profile
        // bridge, and the dedicated atlas-prod bridge (only ever non-empty on the Atlas repo).
        const { host: hostToolNames, profile: profileToolNames } =
          partitionWorkspaceProfileTools(spec.toolBridgeTools);
        const { rest: generalToolNames, atlasProd: atlasProdToolNames } =
          partitionAtlasProdTools(hostToolNames);
        const server = claudeSdk.createSdkMcpServer({
          name: BRIDGE_SERVER_NAME,
          version: '1.0.0',
          instructions:
            'Atlas host tools. Call these to interact with the host harness.',
          tools: generalToolNames.map(makeProxyTool),
          alwaysLoad: true,
        });
        bridge = buildBridgeClaudeOptions(server, generalToolNames);
        if (profileToolNames.length > 0) {
          const profileServer = claudeSdk.createSdkMcpServer({
            name: WORKSPACE_PROFILE_BRIDGE_NAME,
            version: '1.0.0',
            instructions:
              "Atlas Workspace Profile — provision and maintain this repo's durable workspace: secret files, mounts, setup script, MCP servers, skills, and house style.",
            tools: profileToolNames.map(makeProxyTool),
            alwaysLoad: true,
          });
          workspaceProfileBridge = {
            extraClaudeOptions: {
              mcpServers: { [WORKSPACE_PROFILE_BRIDGE_NAME]: profileServer },
            },
            bridgeToolNames: qualifyWorkspaceProfileToolNames(profileToolNames),
          };
        }
        if (atlasProdToolNames.length > 0) {
          const atlasProdServer = claudeSdk.createSdkMcpServer({
            name: ATLAS_PROD_BRIDGE_NAME,
            version: '1.0.0',
            instructions:
              'Atlas prod diagnostics — relocated prod-diagnostics reads plus a gated prod DB write: propose-only, operator-approved.',
            tools: atlasProdToolNames.map(makeProxyTool),
            alwaysLoad: true,
          });
          atlasProdBridge = {
            extraClaudeOptions: {
              mcpServers: { [ATLAS_PROD_BRIDGE_NAME]: atlasProdServer },
            },
            bridgeToolNames: qualifyAtlasProdToolNames(atlasProdToolNames),
          };
        }
      }

      // ── LSP bridge (external stdio MCP server, spawned by the SDK — no Redis round-trip) ────────
      const lsp = buildLspBridgeOptions(spec.mode, spec.cwd);
      // ── User-defined MCP servers (org/repo tiers, resolved host-side) ──────────────────────────
      const userMcp = buildUserMcpBridgeOptions(spec.userMcpServers);

      // ── Mid-turn steering + cooperative stop (only when the host marked the turn steerable) ─────
      const abortController = new AbortController();
      let steerInput:
        | AsyncIterable<{ id?: string; text: string }>
        | undefined;
      if (spec.steerable) {
        await this.transport.onAbort(turnId, () => abortController.abort());
        steerInput = this.transport.readSteerInput(turnId).steerInput;
      }

      const runArgs: RunEngineArgs = {
        ...spec,
        onEvent: (e: EngineEvent) => this.bus.emit(turnId, e),
        ...(spec.steerable
          ? { signal: abortController.signal, steerInput }
          : {}),
        ...(bridgeCall ? { bridgeCall } : {}),
      };
      // The host bridge's + LSP bridge's `mcpServers` MUST be merged into ONE object (each is spread
      // verbatim into the SDK Options), not passed as two separate `extraClaudeOptions`.
      const mergedMcpServers = {
        ...(bridge?.extraClaudeOptions.mcpServers ?? {}),
        ...(workspaceProfileBridge?.extraClaudeOptions.mcpServers ?? {}),
        ...(atlasProdBridge?.extraClaudeOptions.mcpServers ?? {}),
        ...(lsp?.extraClaudeOptions.mcpServers ?? {}),
        ...(userMcp?.extraClaudeOptions.mcpServers ?? {}),
      };
      const mergedToolNames = [
        ...(bridge?.bridgeToolNames ?? []),
        ...(workspaceProfileBridge?.bridgeToolNames ?? []),
        ...(atlasProdBridge?.bridgeToolNames ?? []),
        ...(lsp?.lspToolNames ?? []),
        ...(userMcp?.userMcpToolNames ?? []),
      ];
      // A Codex execute turn hands the BARE bridge tool names to `runCodex` (rendered into config.toml's
      // `[mcp_servers.atlasbridge]` block); Claude uses the merged Claude options above instead.
      const codexBridgeTools =
        spec.engine === 'codex' &&
        spec.toolBridgeTools &&
        spec.toolBridgeTools.length > 0
          ? spec.toolBridgeTools
          : undefined;
      const codexExtraMcpServers =
        spec.engine === 'codex'
          ? { ...(userMcp?.codexExtraMcpServers ?? {}) }
          : undefined;
      const result = await core.runWithExtras(
        runArgs,
        Object.keys(mergedMcpServers).length > 0
          ? { mcpServers: mergedMcpServers }
          : undefined,
        mergedToolNames.length > 0 ? mergedToolNames : undefined,
        codexBridgeTools,
        codexExtraMcpServers,
      );
      await this.transport.emitFinal(turnId, result);
    } catch (err) {
      const e = err as {
        isAuthError?: boolean;
        sessionId?: string;
        engine?: string;
      };
      await this.transport.emitError(turnId, {
        t: 'error',
        message:
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        ...(e?.isAuthError ? { auth: true } : {}),
        ...(typeof e?.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
        ...(typeof e?.engine === 'string' ? { engine: e.engine } : {}),
      });
      throw err;
    }
  }
}
