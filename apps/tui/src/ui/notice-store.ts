export enum ENoticeTone {
  Done = 'done',
  Warn = 'warn',
}

export type Notice = {
  readonly text: string
  readonly tone: ENoticeTone
  readonly issued: number
}

export const NOTICE_MS = 1600

const listeners = new Set<() => void>()

let current: Notice | null = null

let version = 0

let issued = 0

let timer: ReturnType<typeof setTimeout> | null = null

const announce = (): void => {
  version += 1
  for (const listener of listeners) listener()
}

export const subscribeNotices = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const noticeVersion = (): number => version

export const currentNotice = (): Notice | null => current

export function notify(args: { text: string; tone?: ENoticeTone }): void {
  if (timer !== null) clearTimeout(timer)

  issued += 1
  current = { text: args.text, tone: args.tone ?? ENoticeTone.Done, issued }
  announce()

  timer = setTimeout(() => {
    timer = null
    dismissNotice()
  }, NOTICE_MS)
  timer.unref?.()
}

export function dismissNotice(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (current === null) return

  current = null
  announce()
}
