import { EBeforeToolDecision, type BeforeToolOutcome, type ToolCall } from '@dltech/atlas-core'

import { EHookMishapKind, type HookMishap } from '../hooks/budget'

const complaintOf = ({ mishap }: { mishap: HookMishap }): string =>
  mishap.kind === EHookMishapKind.Threw ? `failed: ${mishap.detail}` : mishap.detail

const refusalOf = ({ mishap }: { mishap: HookMishap }): BeforeToolOutcome => ({
  decision: EBeforeToolDecision.Deny,
  reason: `the ${mishap.label} hook ${complaintOf({ mishap })}`,
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
  if (mishap.kind === EHookMishapKind.Overran) return abstentionOf({ call })
  return refusalOf({ mishap })
}
