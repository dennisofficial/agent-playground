import {
  clearNotice as withoutNotice,
  ENoticeTone,
  expireNotices,
  nextExpiryAtMs,
  type Notice,
  postNotice,
} from '@dltech/atlas-core'

export { ENoticeTone }
export type { Notice }

export const NOTICE_MS = 2000

export const NOTICE_WARN_MS = 6000

export const NOTICE_KEY_CLASSIFIER_OFFLINE = 'classifier-offline'

export const NOTICE_KEY_QUICK_MODEL_PREFIX = 'quick-model'

export const NOTICE_KEY_LOST_AGENTS = 'lost-agents'

const listeners = new Set<() => void>()

let notices: readonly Notice[] = []

let version = 0

let issued = 0

let defaultTtlMs = NOTICE_MS

let timer: ReturnType<typeof setTimeout> | null = null

const announce = (): void => {
  version += 1
  for (const listener of listeners) listener()
}

const reschedule = (): void => {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }

  const at = nextExpiryAtMs({ notices })
  if (at === null) return

  timer = setTimeout(
    () => {
      timer = null
      tickNotices({ nowMs: Date.now() })
    },
    Math.max(0, at - Date.now()),
  )
  timer.unref?.()
}

export const subscribeNotices = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const noticeVersion = (): number => version

export const currentNotices = (): readonly Notice[] => notices

export function configureNotices(args: { ttlMs: number }): void {
  defaultTtlMs = args.ttlMs
}

export function notify(args: {
  text: string
  tone?: ENoticeTone
  key?: string
  ttlMs?: number
  sticky?: boolean
}): void {
  issued += 1

  notices = postNotice({
    notices,
    draft: {
      key: args.key ?? `notice-${issued}`,
      text: args.text,
      tone: args.tone ?? ENoticeTone.Done,
      ttlMs: args.sticky === true ? null : (args.ttlMs ?? defaultTtlMs),
    },
    issuedAtMs: Date.now(),
  })
  announce()
  reschedule()
}

export function tickNotices(args: { nowMs: number }): void {
  const standing = expireNotices({ notices, nowMs: args.nowMs })
  if (standing.length === notices.length) return

  notices = standing
  announce()
  reschedule()
}

export function clearNotice(args: { key: string }): void {
  const standing = withoutNotice({ notices, key: args.key })
  if (standing.length === notices.length) return

  notices = standing
  announce()
  reschedule()
}

export function dismissNotice(key?: string): void {
  if (key !== undefined) {
    clearNotice({ key })
    return
  }
  if (notices.length === 0) return

  notices = []
  announce()
  reschedule()
}
