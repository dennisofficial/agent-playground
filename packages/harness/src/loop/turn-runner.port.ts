import type { ThreadId } from '@dltech/atlas-core'

import type { TurnOutcome } from './turn-outcome'

export abstract class TurnRunner {
  abstract say(args: { threadId: ThreadId; text: string; signal?: AbortSignal }): Promise<TurnOutcome>

  abstract runTurn(args: { threadId: ThreadId; signal?: AbortSignal }): Promise<TurnOutcome>
}
