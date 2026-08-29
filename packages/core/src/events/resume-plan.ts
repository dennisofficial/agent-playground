import type { EventDraft } from './body'
import type { Event, EventOfType } from './envelope'
import { awaitsReply, outstandingApproval, pendingCalls } from './projections'

export const RESUME_NUDGE =
  'You were interrupted mid-turn. Continue from exactly where you stopped: finish the thought you were in and carry on with the work. Do not restart, re-plan, or repeat what you already said, and do not remark on the interruption.'

const RESUME_LIFETIME_STEPS = 1

const APPROVAL_WAITING =
  'an approval is waiting for an answer, so answer it rather than resuming past it'

export enum EResume {
  Continue = 'continue',
  Nudge = 'nudge',
  Blocked = 'blocked',
  Nothing = 'nothing',
}

export type ResumePlan =
  | { kind: EResume.Continue }
  | { kind: EResume.Nudge; interrupted: EventOfType<'assistant-said'> }
  | { kind: EResume.Blocked; reason: string }
  | { kind: EResume.Nothing }

export function resumePlan(events: readonly Event[]): ResumePlan {
  if (events.length === 0) return { kind: EResume.Nothing }

  if (outstandingApproval(events) !== undefined) {
    return { kind: EResume.Blocked, reason: APPROVAL_WAITING }
  }

  if (pendingCalls(events).length > 0) return { kind: EResume.Continue }
  if (awaitsReply(events)) return { kind: EResume.Continue }

  const spoke = events.findLast(
    (event): event is EventOfType<'assistant-said'> => event.type === 'assistant-said',
  )

  if (spoke?.interrupted !== true) return { kind: EResume.Nothing }
  return { kind: EResume.Nudge, interrupted: spoke }
}

export function resumeDrafts(events: readonly Event[]): readonly EventDraft[] {
  if (resumePlan(events).kind !== EResume.Nudge) return []
  return [{ type: 'nudge', text: RESUME_NUDGE, lifetimeSteps: RESUME_LIFETIME_STEPS }]
}

export const isResumable = (events: readonly Event[]): boolean => {
  const kind = resumePlan(events).kind
  return kind === EResume.Continue || kind === EResume.Nudge
}
