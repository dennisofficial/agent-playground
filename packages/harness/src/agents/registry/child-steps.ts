import { EAgentStatus, type ClockPort, type EventDraft } from '@dltech/atlas-core'

import type { TurnOutcome } from '../../loop/turn-outcome'
import type { TurnRunner } from '../../loop/turn-runner.port'
import type { AgentType } from '../types'
import type { ChildRunnerSource } from './child-runner'
import {
  agentEndedDraft,
  recordContext,
  recordProgress,
  snapshotOf,
  type ChildState,
} from './child-state'
import type { AgentNoticeQueue } from './notices'
import { statusOf } from './reasons'
import type { AgentRoster } from './roster'

export type ChildStep = (args: { runner: TurnRunner; signal: AbortSignal }) => Promise<TurnOutcome>

export class ChildSteps {
  private readonly runners: ChildRunnerSource
  private readonly roster: AgentRoster
  private readonly notices: AgentNoticeQueue
  private readonly clock: ClockPort
  private readonly inFlight = new Set<Promise<void>>()

  constructor(args: {
    runners: ChildRunnerSource
    roster: AgentRoster
    notices: AgentNoticeQueue
    clock: ClockPort
  }) {
    this.runners = args.runners
    this.roster = args.roster
    this.notices = args.notices
    this.clock = args.clock
  }

  take({
    child,
    agentType,
    step,
  }: {
    child: ChildState
    agentType: AgentType
    step: ChildStep
  }): void {
    child.abort = new AbortController()
    child.status = EAgentStatus.Running
    child.killedBy = undefined
    child.endedAt = undefined
    child.deliveredAt = undefined
    child.steppingSince = this.clock.now()
    this.roster.changed()

    const settled = this.stepped({
      child,
      agentType,
      step,
      signal: child.abort.signal,
    }).then((status) => this.finish({ child, status }))

    this.inFlight.add(settled)
    void settled.finally(() => this.inFlight.delete(settled))
  }

  async whenSettled(): Promise<void> {
    await Promise.all([...this.inFlight])
  }

  private async stepped({
    child,
    agentType,
    step,
    signal,
  }: {
    child: ChildState
    agentType: AgentType
    step: ChildStep
    signal: AbortSignal
  }): Promise<EAgentStatus> {
    try {
      return statusOf(await step({ runner: this.runnerFor({ child, agentType }), signal }))
    } catch {
      return signal.aborted ? EAgentStatus.Stopped : EAgentStatus.Failed
    }
  }

  private finish({ child, status }: { child: ChildState; status: EAgentStatus }): void {
    if (this.roster.find(child.agentId) === undefined) return

    child.status = status
    child.endedAt = this.clock.now()
    child.steppingSince = undefined
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

  private measure({
    child,
    tokens,
    window,
  }: {
    child: ChildState
    tokens: number
    window: number
  }): void {
    recordContext({ child, tokens, window })
    this.roster.changed()
  }

  private runnerFor({ child, agentType }: { child: ChildState; agentType: AgentType }): TurnRunner {
    return this.runners({
      agentType,
      threadId: child.agentId,
      projectDirectory: child.projectDirectory,
      observe: (drafts) => this.record({ child, drafts }),
      observeContext: ({ tokens, window }) => this.measure({ child, tokens, window }),
      steering: () => child.pending.splice(0),
    })
  }
}
