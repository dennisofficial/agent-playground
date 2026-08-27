import type { EventDraft, ModelStepResult, ModelToolCall } from '@dltech/atlas-core'

const INTERRUPTED_BEFORE_RUNNING = 'the developer interrupted the turn before this tool ran'

const calledDraft = ({ call, ordinal }: { call: ModelToolCall; ordinal: number }): EventDraft => ({
  type: 'tool-called',
  callId: call.callId,
  name: call.name,
  input: call.input,
  ordinal,
})

export function draftsFor(result: ModelStepResult): EventDraft[] {
  const drafts: EventDraft[] = []
  if (result.parts.length > 0) drafts.push({ type: 'assistant-said', parts: result.parts })

  result.toolCalls.forEach((call, ordinal) => {
    drafts.push(calledDraft({ call, ordinal }))
  })

  return drafts
}

export function interruptedDrafts(result: ModelStepResult): EventDraft[] {
  const drafts: EventDraft[] = []
  if (result.parts.length > 0) drafts.push({ type: 'assistant-said', parts: result.parts, interrupted: true })

  result.toolCalls.forEach((call, ordinal) => {
    drafts.push(calledDraft({ call, ordinal }))
    drafts.push({
      type: 'tool-denied',
      callId: call.callId,
      name: call.name,
      reason: INTERRUPTED_BEFORE_RUNNING,
    })
  })

  return drafts
}
