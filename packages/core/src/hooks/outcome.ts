import type { EventDraft } from '../events/body'

export type HookOutcome = {
  additionalContext?: string | undefined
  drafts?: readonly EventDraft[] | undefined
}

export const HOOK_CONTEXT_KEY = 'additional-context'

export function hookOutcomeDrafts({
  hookName,
  outcome,
}: {
  hookName: string
  outcome: HookOutcome
}): readonly EventDraft[] {
  const carried = outcome.drafts ?? []
  const context = outcome.additionalContext

  if (context === undefined || context.trim() === '') return carried

  return [
    { type: 'context-loaded', slot: hookName, key: HOOK_CONTEXT_KEY, content: context },
    ...carried,
  ]
}
