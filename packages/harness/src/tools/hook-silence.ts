import { EBeforeToolDecision, type BeforeToolOutcome, type ToolCall } from '@dltech/atlas-core'

import type { HookMishap } from '../hooks/budget'

const refusalOf = ({ mishap }: { mishap: HookMishap }): BeforeToolOutcome => ({
  decision: EBeforeToolDecision.Deny,
  reason: `the ${mishap.label} hook ${mishap.kind === 'threw' ? `failed: ${mishap.detail}` : mishap.detail}`,
})

const abstentionOf = ({ call }: { call: ToolCall }): BeforeToolOutcome => ({
  decision: EBeforeToolDecision.Allow,
  input: call.input,
})

export function outcomeWhenAHookDidNotAnswerInTime({
  mishap,
  call,
}: {
  mishap: HookMishap
  call: ToolCall
}): BeforeToolOutcome {
  if (mishap.kind === 'overran') return abstentionOf({ call })
  return refusalOf({ mishap })
}
