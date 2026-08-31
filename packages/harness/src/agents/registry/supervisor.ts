import {
  EAgentStatus,
  type ClockPort,
  type EKilledBy,
  type EventDraft,
  type EventLogPort,
  type IdPort,
  type ThreadId,
} from '@dltech/atlas-core'

import type { TurnOutcome } from '../../loop/turn-outcome'
import type { TurnRunner } from '../../loop/turn-runner.port'
import type { ThreadStorePort } from '../../store'
import type { AgentType } from '../types'
import type { ChildRunnerSource } from './child-runner'
import {
  agentEndedDraft,
  isStepping,
  recordProgress,
  snapshotOf,
  type ChildState,
} from './child-state'
import { AgentNoticeQueue } from './notices'
import { openChildThread } from './open-child'
import { AgentRegistryPort, type AgentOutcome } from './port'
import { alreadyStepping, EMPTY_BRIEF, statusOf, unknownAgent, unknownAgentType } from './reasons'
import { AgentRoster } from './roster'
import type { AgentSnapshot } from './snapshot'

export class AgentSupervisor extends AgentRegistryPort {
  private readonly log: EventLogPort
  private readonly threads: ThreadStorePort
  private readonly ids: IdPort
  private readonly clock: ClockPort
  private readonly agentTypes: readonly AgentType[]
  private readonly runners: ChildRunnerSource
  private readonly roster = new AgentRoster()
  private readonly notices = new AgentNoticeQueue()
  private readonly inFlight = new Set<Promise<void>>()

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
    this.runners = args.runners
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
      agentType: type,
      intent,
      status: EAgentStatus.Running,
      turns: 0,
      toolCalls: 0,
      lastTool: undefined,
      lastText: '',
      startedAt: this.clock.now(),
      endedAt: undefined,
      abort: new AbortController(),
      pending: [],
    }
    this.roster.add(child)

    this.take({
      child,
      step: ({ runner, signal }) => runner.runTurn({ threadId: agentId, signal }),
    })

    return { ok: true, snapshot: snapshotOf(child) }
  }

  async say({
    agentId,
    threadId,
    text,
  }: {
    agentId: ThreadId
    threadId: ThreadId
    text: string
  }): Promise<AgentOutcome> {
    const child = this.childFor({ agentId, threadId })
    if (child === undefined) {
      return { ok: false, reason: unknownAgent({ agentId, known: this.list({ threadId }) }) }
    }

    if (isStepping(child)) {
      child.pending.push(text)
      return { ok: true, snapshot: snapshotOf(child) }
    }

    await this.log.append({
      threadId: agentId,
      runId: this.ids.nextRunId(),
      drafts: [{ type: 'user-said', text }],
    })
    this.take({
      child,
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

    this.take({ child, step: ({ runner, signal }) => runner.resume({ threadId: agentId, signal }) })

    return { ok: true, snapshot: snapshotOf(child) }
  }

  stop({
    agentId,
    threadId,
  }: {
    agentId: ThreadId
    threadId: ThreadId
    by: EKilledBy
  }): AgentOutcome {
    const child = this.childFor({ agentId, threadId })
    if (child === undefined) {
      return { ok: false, reason: unknownAgent({ agentId, known: this.list({ threadId }) }) }
    }

    child.abort.abort()
    return { ok: true, snapshot: snapshotOf(child) }
  }

  list({ threadId }: { threadId: ThreadId }): readonly AgentSnapshot[] {
    return this.roster.list(threadId)
  }

  listEverywhere(): readonly AgentSnapshot[] {
    return this.roster.listEverywhere()
  }

  drainNotifications({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    return this.notices.drain({ threadId })
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
    for (const child of this.roster.states()) child.abort.abort()
    await Promise.all([...this.inFlight])
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

  private take({
    child,
    step,
  }: {
    child: ChildState
    step: (args: { runner: TurnRunner; signal: AbortSignal }) => Promise<TurnOutcome>
  }): void {
    child.abort = new AbortController()
    child.status = EAgentStatus.Running
    child.endedAt = undefined
    this.roster.changed()

    const settled = this.stepped({ child, step, signal: child.abort.signal }).then((status) =>
      this.finish({ child, status }),
    )

    this.inFlight.add(settled)
    void settled.finally(() => this.inFlight.delete(settled))
  }

  private async stepped({
    child,
    step,
    signal,
  }: {
    child: ChildState
    step: (args: { runner: TurnRunner; signal: AbortSignal }) => Promise<TurnOutcome>
    signal: AbortSignal
  }): Promise<EAgentStatus> {
    try {
      return statusOf(await step({ runner: this.runnerFor(child), signal }))
    } catch {
      return EAgentStatus.Failed
    }
  }

  private finish({ child, status }: { child: ChildState; status: EAgentStatus }): void {
    child.status = status
    child.endedAt = this.clock.now()
    this.roster.changed()

    this.notices.queue({
      threadId: child.spawnedBy,
      snapshot: snapshotOf(child),
      draft: agentEndedDraft(child),
    })
  }

  private record({ child, drafts }: { child: ChildState; drafts: readonly EventDraft[] }): void {
    recordProgress({ child, drafts })
    this.roster.changed()
  }

  private runnerFor(child: ChildState): TurnRunner {
    return this.runners({
      agentType: child.agentType,
      threadId: child.agentId,
      observe: (drafts) => this.record({ child, drafts }),
      steering: () => child.pending.splice(0),
    })
  }
}
