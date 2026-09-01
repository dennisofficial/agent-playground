import type { ModelCard } from '../models/card'

export const CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN = 200_000

export type PromptModel = {
  contextWindow: number
}

export const promptModelOf = (card: ModelCard | undefined): PromptModel => ({
  contextWindow: card?.contextWindow ?? CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN,
})

export const PROMPT_MODEL_SAMPLES: readonly PromptModel[] = [
  { contextWindow: CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN },
  { contextWindow: 400_000 },
  { contextWindow: 1_000_000 },
]

export function promptModelExtremes(): { narrowest: PromptModel; widest: PromptModel } {
  const narrowest = PROMPT_MODEL_SAMPLES[0] ?? {
    contextWindow: CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN,
  }
  const widest = PROMPT_MODEL_SAMPLES[PROMPT_MODEL_SAMPLES.length - 1] ?? narrowest

  return { narrowest, widest }
}
