import type { EndedShell, EventDraft, ThreadId } from '@dltech/atlas-core'

import { withinBudget, type OnHookMishap } from '../hooks/budget'
import type { HookChainSource } from '../hooks/registry'
import { NOTHING_DRAINED } from './notice-queue'

/**
 * Five seconds, and the drafts are forfeit after it. The phase fires from a process exit with no
 * turn around it, and the ending waits on the chain so the drafts have a notice to ride out on — so
 * a hook that never settles is a build the model is never told finished and a session that never
 * quits. The budget is generous enough for a hook that shells out to git or gh and short enough
 * that a teardown which hits it reads as a pause; every shell's hooks are raced together, so it
 * bounds teardown once rather than once per shell, and costs nothing when hooks behave.
 *
 * `HookChain` also bounds each hook individually. This one is not redundant with that: it caps the
 * whole chain, which N well-behaved-but-slow hooks would otherwise stretch to N budgets.
 */
export const AFTER_SHELL_BUDGET_MS = 5_000

export async function afterShellDrafts(args: {
  hooks: HookChainSource
  threadId: ThreadId
  shell: EndedShell
  budgetMs?: number | undefined
  onMishap?: OnHookMishap | undefined
}): Promise<readonly EventDraft[]> {
  return withinBudget({
    label: 'after-shell',
    run: () => args.hooks().afterShell({ threadId: args.threadId, shell: args.shell }),
    fallback: () => NOTHING_DRAINED,
    budgetMs: args.budgetMs ?? AFTER_SHELL_BUDGET_MS,
    onMishap: args.onMishap,
  })
}
