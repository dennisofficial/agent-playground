export enum ENoticeTone {
  Done = 'done',
  Info = 'info',
  Warn = 'warn',
}

export type Notice = {
  readonly key: string
  readonly text: string
  readonly tone: ENoticeTone
  readonly issuedAtMs: number
  readonly ttlMs: number | null
}

export type NoticeDraft = {
  readonly key: string
  readonly text: string
  readonly tone: ENoticeTone
  readonly ttlMs: number | null
}
