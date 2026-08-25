import type { BranchId } from '@dltech/atlas-core'

import { createTurnRunner, ETurnStatus, type TurnDeps, type TurnOutcome, type TurnRunner } from '../loop'
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

export function createPublishingTurnRunner(args: { channel: DeltaChannel; deps: TurnDeps }): TurnRunner {
  const log = withDeltaPublishing({ log: args.deps.log, channel: args.channel })

  const runnerFor = (branchId: BranchId): { publisher: BranchPublisher; runner: TurnRunner } => {
    const publisher = args.channel.publisherFor({ branchId, filter: args.deps.onChunk })
    return { publisher, runner: createTurnRunner({ ...args.deps, log, onChunk: publisher.onChunk }) }
  }

  return {
    say({ branchId, text, signal }) {
      const { publisher, runner } = runnerFor(branchId)
      return publishing({
        publisher,
        run: () => runner.say({ branchId, text, ...(signal === undefined ? {} : { signal }) }),
      })
    },

    runTurn({ branchId, signal }) {
      const { publisher, runner } = runnerFor(branchId)
      return publishing({
        publisher,
        run: () => runner.runTurn({ branchId, ...(signal === undefined ? {} : { signal }) }),
      })
    },
  }
}
