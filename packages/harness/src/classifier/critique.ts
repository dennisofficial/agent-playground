import { generateText, type LanguageModel } from 'ai'

import { critiqueRequestOf, type ClassifierPolicy } from '@dltech/atlas-core'

export const CRITIQUE_OUTPUT_TOKEN_LIMIT = 1024

export enum ECritique {
  Written = 'written',
  Unreachable = 'unreachable',
}

export type Critique =
  { kind: ECritique.Written; text: string } | { kind: ECritique.Unreachable; fault: string }

const messageOf = (fault: unknown): string =>
  fault instanceof Error ? fault.message : String(fault)

export async function critiqueConfiguration({
  model,
  policy,
  signal,
}: {
  model: LanguageModel
  policy: ClassifierPolicy
  signal?: AbortSignal | undefined
}): Promise<Critique> {
  const request = critiqueRequestOf({ policy })

  try {
    const generated = await generateText({
      model,
      system: request.system,
      prompt: request.prompt,
      maxOutputTokens: CRITIQUE_OUTPUT_TOKEN_LIMIT,
      ...(signal === undefined ? {} : { abortSignal: signal }),
    })

    const text = generated.text.trim()
    if (text.length === 0) return { kind: ECritique.Unreachable, fault: 'the model said nothing' }

    return { kind: ECritique.Written, text }
  } catch (fault) {
    return { kind: ECritique.Unreachable, fault: messageOf(fault) }
  }
}
