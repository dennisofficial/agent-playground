import type {
  Assembled,
  ChunkFilter,
  ModelPort,
  ModelStepResult,
  ToolDeclaration,
} from '@dltech/atlas-core'

import { ModelStreamError } from '../model/errors'

export type SteppedTurn =
  | { ok: true; result: ModelStepResult }
  | { ok: false; message: string; cause: unknown }

export async function takeModelStep(args: {
  model: ModelPort
  tools: readonly ToolDeclaration[]
  onChunk: ChunkFilter | undefined
  assembled: Assembled
  signal: AbortSignal
}): Promise<SteppedTurn> {
  try {
    const result = await args.model.step({
      assembled: args.assembled,
      tools: args.tools,
      signal: args.signal,
      ...(args.onChunk === undefined ? {} : { onChunk: args.onChunk }),
    })
    return { ok: true, result }
  } catch (error) {
    if (error instanceof ModelStreamError) {
      return { ok: false, message: error.message, cause: error.cause }
    }
    throw error
  }
}
