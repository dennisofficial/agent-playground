import { MODEL_CATALOG } from '../models/registry'
import type { EPromptAgent } from './agent'
import type { PromptContext } from './context'
import type { PromptFragment } from './fragment'

export const MODEL_ID_OUTSIDE_THE_CATALOGUE = 'uncatalogued-model'

export function reachablePromptContexts(args: {
  agents: readonly EPromptAgent[]
  providerIds: readonly string[]
  projectDirectory: string
}): readonly PromptContext[] {
  const { projectDirectory } = args

  return args.agents.flatMap((agent) =>
    args.providerIds.flatMap((id) => [
      ...MODEL_CATALOG.map((model) => ({
        agent,
        provider: { id, modelId: model.id },
        model,
        projectDirectory,
      })),
      {
        agent,
        provider: { id, modelId: MODEL_ID_OUTSIDE_THE_CATALOGUE },
        model: undefined,
        projectDirectory,
      },
    ]),
  )
}

export function deadFragmentIds(args: {
  fragments: readonly PromptFragment[]
  contexts: readonly PromptContext[]
}): readonly string[] {
  return args.fragments
    .filter((fragment) => !args.contexts.some((ctx) => fragment.applies(ctx)))
    .map((fragment) => fragment.id)
}
