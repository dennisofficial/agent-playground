import { threadHandle } from './thread-slug'

export type ActiveConversation = {
  threadId: string
  title: string | null
  started: boolean
}

export function resumeHint(active: ActiveConversation | null): string | null {
  if (active === null || !active.started) return null

  return `\nResume this conversation with:\n  atlas --resume "${threadHandle(active)}"\n`
}
