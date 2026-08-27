import type { BranchId } from '@dltech/atlas-core'

import { ETurnStatus, LoopTurnRunner, TurnRunner, type TurnDeps, type TurnOutcome } from '../loop'
import type { BranchPublisher, DeltaChannel } from './delta-channel'
import { withDeltaPublishing } from './publishing-event-log'
import { EStepEnd } from './signal'

const endFor = (outcome: TurnOutcome): EStepEnd => {
  if (outcome.status === ETurnStatus.Failed) return EStepEnd.Failed
  if (outcome.status === ETurnStatus.Interrupted) return EStepEnd.Interrupted
  return EStepEnd.Completed
}

async function publishing(args: {
  publisher: BranchPublisher
  run: () => Promise<TurnOutcome>
}): Promise<TurnOutcome> {
  try {
    const outcome = await args.run()
    args.publisher.close({ end: endFor(outcome) })
    return outcome
  } catch (error) {
    args.publisher.close({ end: EStepEnd.Failed })
    throw error
  }
}

export class PublishingTurnRunner extends TurnRunner {
  private readonly channel: DeltaChannel
  private readonly deps: TurnDeps

  constructor(args: { channel: DeltaChannel; deps: TurnDeps }) {
    super()
    this.channel = args.channel
    this.deps = { ...args.deps, log: withDeltaPublishing({ log: args.deps.log, channel: args.channel }) }
  }

  say({ branchId, text, signal }: { branchId: BranchId; text: string; signal?: AbortSignal }): Promise<TurnOutcome> {
    const { publisher, runner } = this.runnerFor(branchId)
    return publishing({
      publisher,
      run: () => runner.say({ branchId, text, ...(signal === undefined ? {} : { signal }) }),
    })
  }

  runTurn({ branchId, signal }: { branchId: BranchId; signal?: AbortSignal }): Promise<TurnOutcome> {
    const { publisher, runner } = this.runnerFor(branchId)
    return publishing({
      publisher,
      run: () => runner.runTurn({ branchId, ...(signal === undefined ? {} : { signal }) }),
    })
  }

  private runnerFor(branchId: BranchId): { publisher: BranchPublisher; runner: TurnRunner } {
    const publisher = this.channel.publisherFor({ branchId, filter: this.deps.onChunk })
    return { publisher, runner: new LoopTurnRunner({ ...this.deps, onChunk: publisher.onChunk }) }
  }
}
