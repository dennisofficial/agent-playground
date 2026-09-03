import { threadHandle } from './thread-slug'

export type ActiveConversation = {
  threadId: string
  title: string | null
  started: boolean
}

export function resumeHint(args: {
  active: ActiveConversation | null
  command: string
}): string | null {
  const active = args.active
  if (active === null || !active.started) return null

  return `\nResume this conversation with:\n  ${args.command} --resume "${threadHandle(active)}"\n`
}
