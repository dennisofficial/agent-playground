import {
  EAgentStatus,
  EKilledBy,
  EMessageOrigin,
  type ClockPort,
  type EventDraft,
  type EventLogPort,
  type IdPort,
  type SaidImage,
  type ThreadId,
} from '@dltech/atlas-core'

import type { ThreadStorePort } from '../../store'
import type { ChildRunnerSource } from './child-runner'
import type { AgentType } from '../types'
import { ChildSteps } from './child-steps'
import { isStepping, snapshotOf, type ChildState } from './child-state'
import { AgentNoticeQueue } from './notices'
import { openChildThread } from './open-child'
import { AgentRegistryPort, type AgentOutcome } from './port'
import { ChildRecovery } from './recovery'
import {
  alreadyStepping,
  EMPTY_BRIEF,
  retiredAgentType,
  unknownAgent,
  unknownAgentType,
} from './reasons'
import { AgentRoster } from './roster'
import type { AgentSnapshot, RecoveredAgents } from './snapshot'

export class AgentSupervisor extends AgentRegistryPort {
  private readonly log: EventLogPort
  private readonly threads: ThreadStorePort
  private readonly ids: IdPort
  private readonly clock: ClockPort
  private readonly agentTypes: readonly AgentType[]
  private readonly roster = new AgentRoster()
  private readonly notices = new AgentNoticeQueue()
  private readonly steps: ChildSteps
  private readonly recovery: ChildRecovery

  constructor(args: {
    log: EventLogPort
    threads: ThreadStorePort
    ids: IdPort
    clock: ClockPort
    agentTypes: readonly AgentType[]
    runners: ChildRunnerSource
  }) {
    super()
    this.log = args.log
    this.threads = args.threads
    this.ids = args.ids
    this.clock = args.clock
    this.agentTypes = args.agentTypes
    this.steps = new ChildSteps({
      runners: args.runners,
      roster: this.roster,
      notices: this.notices,
      clock: args.clock,
    })
    this.recovery = new ChildRecovery({
      log: args.log,
      threads: args.threads,
      ids: args.ids,
      clock: args.clock,
      roster: this.roster,
    })
  }

  types(): readonly AgentType[] {
    return this.agentTypes
  }

  async spawn({
    threadId,
    agentType,
    brief,
    intent,
  }: {
    threadId: ThreadId
    agentType: string
    brief: string
    intent: string
  }): Promise<AgentOutcome> {
    const type = this.agentTypes.find((one) => one.name === agentType)
    if (type === undefined) {
      return { ok: false, reason: unknownAgentType({ agentType, known: this.agentTypes }) }
    }
    if (brief.trim() === '') return { ok: false, reason: EMPTY_BRIEF }

    const agentId = await openChildThread({
      threads: this.threads,
      log: this.log,
      ids: this.ids,
      spawnedBy: threadId,
      agentType: type,
      brief,
      intent,
    })

    const child: ChildState = {
      agentId,
      spawnedBy: threadId,
      agentType: type.name,
      intent,
      status: EAgentStatus.Running,
      killedBy: undefined,
      turns: 0,
      toolCalls: 0,
      lastTool: undefined,
      lastText: '',
      startedAt: this.clock.now(),
      endedAt: undefined,
      deliveredAt: undefined,
      abort: new AbortController(),
      pending: [],
      context: undefined,
    }
    this.roster.add(child)

    this.steps.take({
      child,
      agentType: type,
      step: ({ runner, signal }) => runner.runTurn({ threadId: agentId, signal }),
    })

    return { ok: true, snapshot: snapshotOf(child) }
  }

  async say({
    agentId,
    threadId,
    text,
    images,
  }: {
    agentId: ThreadId
    threadId: ThreadId
    text: string
    images?: readonly SaidImage[] | undefined
  }): Promise<AgentOutcome> {
    const child = this.childFor({ agentId, threadId })
    if (child === undefined) {
      return { ok: false, reason: unknownAgent({ agentId, known: this.list({ threadId }) }) }
    }

    if (isStepping(child)) {
      child.pending.push({ text, images })
      return { ok: true, snapshot: snapshotOf(child) }
    }

    const agentType = this.typeNamed(child.agentType)
    if (agentType === undefined) {
      return { ok: false, reason: retiredAgentType(child.agentType) }
    }

    await this.log.append({
      threadId: agentId,
      runId: this.ids.nextRunId(),
      drafts: [
        {
          type: 'user-said',
          text,
          via: EMessageOrigin.ParentAgent,
          ...(images === undefined || images.length === 0 ? {} : { images }),
        },
      ],
    })
    this.steps.take({
      child,
      agentType,
      step: ({ runner, signal }) => runner.runTurn({ threadId: agentId, signal }),
    })

    return { ok: true, snapshot: snapshotOf(child) }
  }

  async resume({
    agentId,
    threadId,
  }: {
    agentId: ThreadId
    threadId: ThreadId
  }): Promise<AgentOutcome> {
    const child = this.childFor({ agentId, threadId })
    if (child === undefined) {
      return { ok: false, reason: unknownAgent({ agentId, known: this.list({ threadId }) }) }
    }
    if (isStepping(child)) return { ok: false, reason: alreadyStepping(agentId) }

    const agentType = this.typeNamed(child.agentType)
    if (agentType === undefined) {
      return { ok: false, reason: retiredAgentType(child.agentType) }
    }

    this.steps.take({
      child,
      agentType,
      step: ({ runner, signal }) => runner.resume({ threadId: agentId, signal }),
    })

    return { ok: true, snapshot: snapshotOf(child) }
  }

  stop({
    agentId,
    threadId,
    by,
  }: {
    agentId: ThreadId
    threadId: ThreadId
    by: EKilledBy
  }): AgentOutcome {
    const child = this.childFor({ agentId, threadId })
    if (child === undefined) {
      return { ok: false, reason: unknownAgent({ agentId, known: this.list({ threadId }) }) }
    }
    if (!isStepping(child)) return { ok: true, snapshot: snapshotOf(child) }

    child.killedBy = by
    child.abort.abort()
    return { ok: true, snapshot: snapshotOf(child) }
  }

  list({ threadId }: { threadId: ThreadId }): readonly AgentSnapshot[] {
    void this.hydrate({ threadId })
    return this.roster.list(threadId)
  }

  hydrate({ threadId }: { threadId: ThreadId }): Promise<void> {
    return this.recovery.hydrate({ threadId })
  }

  recordLostAgents({ threadId }: { threadId: ThreadId }): Promise<RecoveredAgents> {
    return this.recovery.recordLost({ threadId })
  }

  listEverywhere(): readonly AgentSnapshot[] {
    return this.roster.listEverywhere()
  }

  drainNotifications({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    const handed = this.notices.pending({ threadId })
    const drafts = this.notices.drain({ threadId })
    this.recordDelivery(handed)
    return drafts
  }

  pendingNotices({ threadId }: { threadId: ThreadId }): readonly AgentSnapshot[] {
    return this.notices.pending({ threadId })
  }

  threadsAwaitingNotice(): readonly ThreadId[] {
    return this.notices.threadsAwaiting()
  }

  onNotice(listener: () => void): () => void {
    return this.notices.onNotice(listener)
  }

  onChange(listener: () => void): () => void {
    return this.roster.onChange(listener)
  }

  forgetNotices({ threadId }: { threadId: ThreadId }): void {
    this.notices.forget({ threadId })
  }

  /**
   * An ending announces itself even when teardown caused it: reopening the conversation should say
   * where a child went, exactly as it says where a background shell went.
   */
  async closeAll(): Promise<void> {
    for (const child of this.roster.states()) {
      if (isStepping(child) && child.killedBy === undefined) child.killedBy = EKilledBy.SessionEnd
      child.abort.abort()
    }
    await this.steps.whenSettled()
  }

  private recordDelivery(handed: readonly AgentSnapshot[]): void {
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

  private childFor({
    agentId,
    threadId,
  }: {
    agentId: ThreadId
    threadId: ThreadId
  }): ChildState | undefined {
    const child = this.roster.find(agentId)
    return child === undefined || child.spawnedBy !== threadId ? undefined : child
  }

  private typeNamed(name: string): AgentType | undefined {
    return this.agentTypes.find((one) => one.name === name)
  }
}
