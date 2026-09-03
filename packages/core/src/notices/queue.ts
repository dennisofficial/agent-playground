import type { Notice, NoticeDraft } from './notice'

export const NOTICE_STACK_LIMIT = 3

export function postNotice(args: {
  notices: readonly Notice[]
  draft: NoticeDraft
  issuedAtMs: number
  limit?: number
}): readonly Notice[] {
  const notice: Notice = { ...args.draft, issuedAtMs: args.issuedAtMs }
  const limit = args.limit ?? NOTICE_STACK_LIMIT

  const existing = args.notices.findIndex((held) => held.key === notice.key)
  if (existing >= 0) return args.notices.map((held, index) => (index === existing ? notice : held))

  const next = [...args.notices, notice]
  if (next.length <= limit) return next

  const posted = next.length - 1
  const oldestOtherExpiring = next.findIndex((held, index) => index !== posted && held.ttlMs !== null)
  const dropped = oldestOtherExpiring >= 0 ? oldestOtherExpiring : 0
  return next.filter((_, index) => index !== dropped)
}

export function expireNotices(args: {
  notices: readonly Notice[]
  nowMs: number
}): readonly Notice[] {
  return args.notices.filter(
    (notice) => notice.ttlMs === null || notice.issuedAtMs + notice.ttlMs > args.nowMs,
  )
}

export function clearNotice(args: {
  notices: readonly Notice[]
  key: string
}): readonly Notice[] {
  return args.notices.filter((notice) => notice.key !== args.key)
}

export function nextExpiryAtMs(args: { notices: readonly Notice[] }): number | null {
  let soonest: number | null = null
  for (const notice of args.notices) {
    if (notice.ttlMs === null) continue
    const at = notice.issuedAtMs + notice.ttlMs
    if (soonest === null || at < soonest) soonest = at
  }
  return soonest
}
