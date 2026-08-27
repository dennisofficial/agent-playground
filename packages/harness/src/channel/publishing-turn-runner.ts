import type { ThreadId } from '@dltech/atlas-core'

import { ETurnStatus, LoopTurnRunner, TurnRunner, type TurnDeps, type TurnOutcome } from '../loop'
import type { ThreadPublisher, DeltaChannel } from './delta-channel'
import { withDeltaPublishing } from './publishing-event-log'
import { EStepEnd } from './signal'

const endFor = (outcome: TurnOutcome): EStepEnd => {
  if (outcome.status === ETurnStatus.Failed) return EStepEnd.Failed
  if (outcome.status === ETurnStatus.Interrupted) return EStepEnd.Interrupted
  return EStepEnd.Completed
}

async function publishing(args: {
  publisher: ThreadPublisher
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

  say({ threadId, text, signal }: { threadId: ThreadId; text: string; signal?: AbortSignal }): Promise<TurnOutcome> {
    const { publisher, runner } = this.runnerFor(threadId)
    return publishing({
      publisher,
      run: () => runner.say({ threadId, text, ...(signal === undefined ? {} : { signal }) }),
    })
  }

  runTurn({ threadId, signal }: { threadId: ThreadId; signal?: AbortSignal }): Promise<TurnOutcome> {
    const { publisher, runner } = this.runnerFor(threadId)
    return publishing({
      publisher,
      run: () => runner.runTurn({ threadId, ...(signal === undefined ? {} : { signal }) }),
    })
  }

  private runnerFor(threadId: ThreadId): { publisher: ThreadPublisher; runner: TurnRunner } {
    const publisher = this.channel.publisherFor({ threadId, filter: this.deps.onChunk })
    return { publisher, runner: new LoopTurnRunner({ ...this.deps, onChunk: publisher.onChunk }) }
  }
}
