import {
  agentRoster,
  type ClockPort,
  type EventLogPort,
  type IdPort,
  type ThreadId,
} from '@dltech/atlas-core'

import type { ThreadStorePort } from '../../store'
import { recoveredChild } from './child-state'
import { settleLostChildren, unloggedChildren } from './lost-children'
import type { AgentRoster } from './roster'
import type { RecoveredAgents } from './snapshot'

export class ChildRecovery {
  private readonly log: EventLogPort
  private readonly threads: ThreadStorePort
  private readonly ids: IdPort
  private readonly clock: ClockPort
  private readonly roster: AgentRoster
  private readonly hydrating = new Map<ThreadId, Promise<void>>()

  constructor(args: {
    log: EventLogPort
    threads: ThreadStorePort
    ids: IdPort
    clock: ClockPort
    roster: AgentRoster
  }) {
    this.log = args.log
    this.threads = args.threads
    this.ids = args.ids
    this.clock = args.clock
    this.roster = args.roster
  }

  /**
   * A child outlives the process that spawned it, because its thread and its rows do. The parent's
   * own log is the whole record, so a restart rebuilds the roster from it rather than from a side
   * table; this is deliberately not done at construction, where a container resolve would block on
   * the database.
   */
  hydrate({ threadId }: { threadId: ThreadId }): Promise<void> {
    const started = this.hydrating.get(threadId)
    if (started !== undefined) return started

    const running = this.rebuild({ threadId }).catch(() => {
      this.hydrating.delete(threadId)
    })
    this.hydrating.set(threadId, running)

    return running
  }

  /**
   * Rebuilding only reads; this writes. A child the process lost has no ending in its parent's log
   * and nothing else will ever write one, so the record stays a lie, and the parent cannot be
   * rewound below the spawn, until someone settles it deliberately.
   *
   * The two kinds are not the same repair. A lost child is a spawn the parent recorded and an
   * ending nobody lived to write, so this completes the record. An unlogged child is a thread the
   * parent never recorded at all, and it is only reported.
   */
  async recordLost({ threadId }: { threadId: ThreadId }): Promise<RecoveredAgents> {
    await this.hydrate({ threadId })

    const mine = this.roster.states().filter((child) => child.spawnedBy === threadId)
    const settled = await settleLostChildren({
      log: this.log,
      ids: this.ids,
      clock: this.clock,
      children: mine,
      threadId,
    })
    if (settled.length > 0) this.roster.changed()

    const unlogged = await unloggedChildren({
      threads: this.threads,
      threadId,
      known: new Set(mine.map((child) => child.agentId)),
    })

    return { settled, unlogged }
  }

  private async rebuild({ threadId }: { threadId: ThreadId }): Promise<void> {
    const events = await this.log.readOwn({ threadId })
    const at = this.clock.now()

    for (const agent of agentRoster({ events, threadId })) {
      if (this.roster.find(agent.agentId) !== undefined) continue
      this.roster.add(recoveredChild({ agent, spawnedBy: threadId, at }))
    }
  }
}
