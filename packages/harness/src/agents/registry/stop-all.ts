import { EKilledBy } from '@dltech/atlas-core'

import { isStepping, type ChildState } from './child-state'
import type { ChildSteps } from './child-steps'
import type { AgentRoster } from './roster'

/**
 * An ending announces itself even when teardown caused it: reopening the conversation should say
 * where a child went, exactly as it says where a background shell went.
 */
export async function stopAllChildren({
  roster,
  steps,
}: {
  roster: AgentRoster
  steps: ChildSteps
}): Promise<void> {
  for (const child of roster.states()) {
    if (isStepping(child) && child.killedBy === undefined) child.killedBy = EKilledBy.SessionEnd
    child.abort.abort()
  }
  await steps.whenSettled()
}

export function stopChild({ child, by }: { child: ChildState; by: EKilledBy }): void {
  if (!isStepping(child)) return
  child.killedBy = by
  child.abort.abort()
}
