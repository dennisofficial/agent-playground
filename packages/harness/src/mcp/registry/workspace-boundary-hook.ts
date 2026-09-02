import {
  BeforeToolHook,
  DynamicToolSource,
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  type BeforeTool,
  type HookOrder,
} from '@dltech/atlas-core'

import { portToken, resolveSet, type DependencyContainer } from '../../container/injection'
import { ToolRegistry } from '../../tools/registry'

const MCP_PREFIX = 'mcp__'

export abstract class McpHandleTrust {
  abstract trusted(args: { tool: string }): boolean
}

class UntrustedHandles extends McpHandleTrust {
  trusted(): boolean {
    return false
  }
}

export class WorkspaceBoundaryHook extends BeforeToolHook {
  readonly name = 'workspaceBoundary'
  readonly order: HookOrder = { stage: EStage.Guard, nudge: -2 }

  private readonly tools: ToolRegistry
  private readonly sources: readonly DynamicToolSource[]
  private readonly trust: McpHandleTrust

  constructor(args: {
    tools: ToolRegistry
    sources: readonly DynamicToolSource[]
    trust: McpHandleTrust
  }) {
    super()
    this.tools = args.tools
    this.sources = args.sources
    this.trust = args.trust
  }

  private isMcpName(name: string): boolean {
    if (name.startsWith(MCP_PREFIX)) return true
    return this.sources.some((source) =>
      source.declarations().some((declaration) => declaration.name === name),
    )
  }

  readonly run: BeforeTool = async ({ call }) => {
    if (!this.isMcpName(call.name)) {
      return { decision: EBeforeToolDecision.Allow, input: call.input }
    }

    const effect = this.tools.find(call.name)?.effect ?? call.effect
    if (effect === EToolEffect.Read) {
      return { decision: EBeforeToolDecision.Allow, input: call.input }
    }

    if (!this.trust.trusted({ tool: call.name })) {
      return {
        decision: EBeforeToolDecision.Ask,
        reason: `${call.name} comes from an MCP server that is not marked trusted, so an operator must approve the change it wants to make before it runs`,
      }
    }

    return { decision: EBeforeToolDecision.Allow, input: call.input }
  }
}

export function createWorkspaceBoundaryHook(args: {
  container: DependencyContainer
}): BeforeToolHook {
  return new WorkspaceBoundaryHook({
    tools: args.container.resolve(portToken(ToolRegistry)),
    sources: resolveSet({ container: args.container, token: portToken(DynamicToolSource) }),
    trust: args.container.isRegistered(portToken(McpHandleTrust), true)
      ? args.container.resolve(portToken(McpHandleTrust))
      : new UntrustedHandles(),
  })
}
