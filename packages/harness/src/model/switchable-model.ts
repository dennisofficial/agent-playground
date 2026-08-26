import type { LanguageModelV4 } from '@ai-sdk/provider'

export type Switchable<TChoice> = {
  model: LanguageModelV4
  choice: () => TChoice
  select: (next: TChoice) => void
}

/**
 * One `LanguageModelV4` whose answering model can be swapped between turns. The ai SDK reads
 * `provider` and `modelId` off the object it was handed rather than per call, so both are getters:
 * a plain spread would freeze the identity of whichever model was selected first.
 */
export function createSwitchableModel<TChoice>(args: {
  initial: TChoice
  keyOf: (choice: TChoice) => string
  build: (choice: TChoice) => LanguageModelV4
}): Switchable<TChoice> {
  let choice = args.initial
  const built = new Map<string, LanguageModelV4>()

  const current = (): LanguageModelV4 => {
    const key = args.keyOf(choice)
    const cached = built.get(key)
    if (cached !== undefined) return cached

    const model = args.build(choice)
    built.set(key, model)
    return model
  }

  return {
    model: {
      specificationVersion: 'v4',
      get provider() {
        return current().provider
      },
      get modelId() {
        return current().modelId
      },
      get supportedUrls() {
        return current().supportedUrls
      },
      doGenerate: (options) => current().doGenerate(options),
      doStream: (options) => current().doStream(options),
    },
    choice: () => choice,
    select: (next) => {
      choice = next
    },
  }
}
