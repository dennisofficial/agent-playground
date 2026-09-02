import { McpHandleTrust } from '../registry/workspace-boundary-hook'
import { McpBridgeTool } from './bridge-tool'
import { HandleStore } from './handle-store'

export class TrustResolver extends McpHandleTrust {
  private readonly store: HandleStore

  constructor(args: { store: HandleStore }) {
    super()
    this.store = args.store
  }

  trusted(args: { tool: string }): boolean {
    const found = this.store.find(args.tool)
    if (!(found instanceof McpBridgeTool)) return false

    const handle = this.store.statusOf({ serverId: found.serverId })
    return handle?.spec.trusted === true
  }
}
