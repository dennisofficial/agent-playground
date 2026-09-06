import { tldrDue, type EventLogPort, type IdPort, type ThreadId } from '@dltech/atlas-core'
import type { LanguageModel } from 'ai'

import { tldrFor } from '../model/tldr'
import { ETurnStatus, type TurnOutcome } from './turn-outcome'
import { TurnRunner } from './turn-runner.port'

type TurnArgs = { threadId: ThreadId; signal?: AbortSignal }

export type TldrFeed = {
  started(args: { threadId: ThreadId; anchorSeq: number }): void
  chunk(args: { threadId: ThreadId; text: string }): void
  finished(args: { threadId: ThreadId }): void
}

export class TldrTurnRunner extends TurnRunner {
  private readonly inner: TurnRunner
  private readonly log: EventLogPort
  private readonly ids: IdPort
  private readonly model: LanguageModel
  private readonly modelId: () => string
  private readonly feed: TldrFeed | undefined
  private readonly onMishap: ((error: unknown) => void) | undefined

  constructor(args: {
    inner: TurnRunner
    log: EventLogPort
    ids: IdPort
    model: LanguageModel
    modelId: () => string
    feed?: TldrFeed | undefined
    onMishap?: ((error: unknown) => void) | undefined
  }) {
    super()
    this.inner = args.inner
    this.log = args.log
    this.ids = args.ids
    this.model = args.model
    this.modelId = args.modelId
    this.feed = args.feed
    this.onMishap = args.onMishap
  }

  say(args: TurnArgs & { text: string }): Promise<TurnOutcome> {
    return this.drive({ threadId: args.threadId, run: () => this.inner.say(args) })
  }

  runTurn(args: TurnArgs): Promise<TurnOutcome> {
    return this.drive({ threadId: args.threadId, run: () => this.inner.runTurn(args) })
  }

  resume(args: TurnArgs): Promise<TurnOutcome> {
    return this.drive({ threadId: args.threadId, run: () => this.inner.resume(args) })
  }

  private async drive(args: { threadId: ThreadId; run: () => Promise<TurnOutcome> }): Promise<TurnOutcome> {
    const outcome = await args.run()
    if (outcome.status === ETurnStatus.Completed) {
      void this.write({ threadId: args.threadId }).catch((error: unknown) => this.onMishap?.(error))
    }
    return outcome
  }

  private async write(args: { threadId: ThreadId }): Promise<void> {
    const events = await this.log.read({ threadId: args.threadId })
    const due = tldrDue(events)
    if (due === undefined) return

    this.feed?.started({ threadId: args.threadId, anchorSeq: due.anchorSeq })
    try {
      const result = await tldrFor({
        model: this.model,
        events,
        anchorSeq: due.anchorSeq,
        throughSeq: due.throughSeq,
        onChunk: (partial) => this.feed?.chunk({ threadId: args.threadId, text: partial }),
      })
      if (result === null) return

      const still = tldrDue(await this.log.read({ threadId: args.threadId }))
      if (still === undefined || still.anchorSeq !== due.anchorSeq || still.throughSeq !== due.throughSeq) {
        return
      }

      await this.log.append({
        threadId: args.threadId,
        runId: this.ids.nextRunId(),
        drafts: [
          {
            type: 'tldr-written',
            anchorSeq: due.anchorSeq,
            throughSeq: due.throughSeq,
            text: result.text,
            status: result.status,
            modelId: this.modelId(),
          },
        ],
      })
    } finally {
      this.feed?.finished({ threadId: args.threadId })
    }
  }
}
