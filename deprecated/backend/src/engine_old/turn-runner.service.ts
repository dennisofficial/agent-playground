import { Injectable } from '@nestjs/common';
import {
  ATLAS_PROD_BRIDGE_NAME,
  partitionAtlasProdTools,
  qualifyAtlasProdToolNames,
} from '@shared/bridge-names/atlas-prod-bridge-options';
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
import { EngineCore } from '@shared/engine/engine-core';
import type { EngineEvent, RunEngineArgs } from '@shared/engine/engine.types';
import { TOOL_DESCRIPTIONS, TOOL_SHAPES } from '@shared/engine/host-tool-schemas';
import { EngineEventBus } from './events/engine-events';
import { buildLspBridgeOptions } from './transport/bridges/lsp-bridge-options';
import { buildUserMcpBridgeOptions } from './transport/bridges/user-mcp-bridge-options';
import { TurnTransport } from './transport/turn-transport.service';

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
        homeRoot: process.env.AGENT_HOME_ROOT,
        skillsRoot: process.env.SKILLS_ROOT,
        managedSkillsRoot: process.env.SKILLS_MANAGED_ROOT,
        managedGitSkillsRoot: process.env.SKILLS_MANAGED_GIT_ROOT,
      });

      let bridge: BridgeClaudeOptions | undefined;
      let bridgeCall:
        | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
        | undefined;
      let workspaceProfileBridge: BridgeClaudeOptions | undefined;
      let atlasProdBridge: BridgeClaudeOptions | undefined;
      if (spec.engine === 'claude' && Array.isArray(spec.toolBridgeTools)) {
        const toolBridge = this.transport.openToolBridge(turnId);
        bridgeCall = (name, args) => toolBridge.call(name, args);

        const makeProxyTool = (toolName: string) => {
          const shape = TOOL_SHAPES[toolName];
          if (!shape) {
            throw new Error(`[turn-runner] no TOOL_SHAPES entry for bridged tool '${toolName}'`);
          }
          return claudeSdk.tool(
            toolName,
            TOOL_DESCRIPTIONS[toolName] ??
              `Host-side tool '${toolName}' proxied via the Atlas tool bridge.`,
            shape,
            async (input: Record<string, unknown>) => {
              try {
                const result = await toolBridge.call(toolName, input ?? {});
                const text = typeof result === 'string' ? result : JSON.stringify(result);
                return { content: [{ type: 'text' as const, text }] };
              } catch (err) {
                const message =
                  (err instanceof Error ? err.message : String(err)) ||
                  'host tool error (no message)';
                return {
                  content: [{ type: 'text' as const, text: `Error: ${message}` }],
                  isError: true,
                };
              }
            },
          );
        };
        const { host: hostToolNames, profile: profileToolNames } = partitionWorkspaceProfileTools(
          spec.toolBridgeTools,
        );
        const { rest: generalToolNames, atlasProd: atlasProdToolNames } =
          partitionAtlasProdTools(hostToolNames);
        if (generalToolNames.length > 0) {
          const server = claudeSdk.createSdkMcpServer({
            name: BRIDGE_SERVER_NAME,
            version: '1.0.0',
            instructions: 'Atlas host tools. Call these to interact with the host harness.',
            tools: generalToolNames.map(makeProxyTool),
            alwaysLoad: true,
          });
          bridge = buildBridgeClaudeOptions(server, generalToolNames);
        }
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

      const lsp = buildLspBridgeOptions(spec.mode, spec.cwd);
      const userMcp = buildUserMcpBridgeOptions(spec.userMcpServers);

      const abortController = new AbortController();
      let steerInput: AsyncIterable<{ id?: string; text: string }> | undefined;
      if (spec.steerable) {
        await this.transport.onAbort(turnId, () => abortController.abort());
        steerInput = this.transport.readSteerInput(turnId).steerInput;
      }

      const runArgs: RunEngineArgs = {
        ...spec,
        onEvent: (e: EngineEvent) => this.bus.emit(turnId, e),
        ...(spec.steerable ? { signal: abortController.signal, steerInput } : {}),
        ...(bridgeCall ? { bridgeCall } : {}),
      };
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
      const codexBridgeTools =
        spec.engine === 'codex' && spec.toolBridgeTools && spec.toolBridgeTools.length > 0
          ? spec.toolBridgeTools
          : undefined;
      const codexExtraMcpServers =
        spec.engine === 'codex' ? { ...(userMcp?.codexExtraMcpServers ?? {}) } : undefined;
      const result = await core.runWithExtras(
        runArgs,
        Object.keys(mergedMcpServers).length > 0 ? { mcpServers: mergedMcpServers } : undefined,
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
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
        ...(e?.isAuthError ? { auth: true } : {}),
        ...(typeof e?.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
        ...(typeof e?.engine === 'string' ? { engine: e.engine } : {}),
      });
      throw err;
    }
  }
}
