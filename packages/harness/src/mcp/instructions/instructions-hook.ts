import {
  BeforeTurnHook,
  EContextSlot,
  EStage,
  type BeforeTurn,
  type EventDraft,
  type HookOrder,
  type ThreadId,
} from '@dltech/atlas-core'

import type { HandleStore } from '../bridge/handle-store'
import { EMcpServerStatus } from '../registry/handle-status'

export class McpInstructionsHook extends BeforeTurnHook {
  readonly name = 'mcpInstructions'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly store: HandleStore
  private readonly offeredByThread = new Map<ThreadId, Set<string>>()

  constructor(args: { store: HandleStore }) {
    super()
    this.store = args.store
  }

  readonly run: BeforeTurn = async ({ threadId }) => {
    const offered = this.offeredByThread.get(threadId) ?? new Set<string>()
    const live = this.liveInstructions()
    const drafts: EventDraft[] = []

    for (const [serverId, instructions] of live) {
      if (offered.has(serverId)) continue
      drafts.push({
        type: 'context-loaded',
        slot: EContextSlot.McpInstructions,
        key: serverId,
        content: instructions,
      })
      offered.add(serverId)
    }

    for (const serverId of [...offered]) {
      if (live.has(serverId)) continue
      drafts.push({
        type: 'context-loaded',
        slot: EContextSlot.McpInstructions,
        key: serverId,
        content: '',
      })
      offered.delete(serverId)
    }

    this.offeredByThread.set(threadId, offered)
    return drafts.length === 0 ? {} : { drafts }
  }

  private liveInstructions(): Map<string, string> {
    const live = new Map<string, string>()
    for (const handle of this.store.allHandles()) {
      if (handle.state.status !== EMcpServerStatus.Connected) continue
      const instructions = handle.capabilities?.instructions
      if (instructions === undefined || instructions.length === 0) continue
      live.set(handle.spec.name, instructions)
    }
    return live
  }
}
