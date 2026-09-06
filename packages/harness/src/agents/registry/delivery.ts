import type { ClockPort, EventDraft, ThreadId } from '@dltech/atlas-core'

import type { AgentNoticeQueue } from './notices'
import type { AgentRoster } from './roster'
import type { AgentSnapshot } from './snapshot'

export class NoticeDelivery {
  private readonly notices: AgentNoticeQueue
  private readonly roster: AgentRoster
  private readonly clock: ClockPort

  constructor(args: { notices: AgentNoticeQueue; roster: AgentRoster; clock: ClockPort }) {
    this.notices = args.notices
    this.roster = args.roster
    this.clock = args.clock
  }

  drain({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    const handed = this.notices.pending({ threadId })
    const drafts = this.notices.drain({ threadId })
    this.stampDelivered(handed)
    return drafts
  }

  private stampDelivered(handed: readonly AgentSnapshot[]): void {
    if (handed.length === 0) return

    const at = this.clock.now()
    let stamped = false

    for (const snapshot of handed) {
      const child = this.roster.find(snapshot.agentId)
      if (child === undefined || child.deliveredAt !== undefined) continue
      child.deliveredAt = at
      stamped = true
    }

    if (stamped) this.roster.changed()
  }
}
