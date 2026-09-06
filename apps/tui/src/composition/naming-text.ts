import { EContextSlot, type EventDraft } from '@dltech/atlas-core'

/**
 * An attached file goes to the titler as its head alone: the opening of a handoff or spec is where
 * its subject is stated, and the titler's own prompt cap bounds the whole ask anyway.
 */
export const NAMING_ATTACHMENT_CHARACTER_LIMIT = 1000

const attachmentExcerpt = (draft: EventDraft): string[] => {
  if (draft.type !== 'context-loaded' || draft.slot !== EContextSlot.File) return []

  const content = draft.content.trim().slice(0, NAMING_ATTACHMENT_CHARACTER_LIMIT)
  if (content.length === 0) return []

  return [`[Attached file: ${draft.key}]\n${content}`]
}

/**
 * What the titler names the session from: the opening message, plus the head of each file attached
 * to it. A handoff or spec the message only points at carries the subject the message itself lacks
 * — "check out this handoff" names nothing without it. Skill drafts are left out on purpose: the
 * message already names the skill, and its body would only teach the titler the workflow's words.
 */
export function namingTextOf(args: {
  said: string
  context?: readonly EventDraft[] | undefined
}): string {
  const excerpts = (args.context ?? []).flatMap(attachmentExcerpt)
  return [args.said, ...excerpts].join('\n\n')
}
