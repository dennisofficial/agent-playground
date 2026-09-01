export enum EWorktreeLockHolder {
  Absent = 'absent',
  Ours = 'ours',
  LiveOther = 'live-other',
  Stale = 'stale',
  Foreign = 'foreign',
}

export type WorktreeLockIdentity = { pid: number; start: string | undefined }

const PREFIX = 'atlas'

const TOKEN = /^atlas .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$/

export function worktreeLockToken(args: { label: string; identity: WorktreeLockIdentity }): string {
  const { pid, start } = args.identity
  const tail = start === undefined ? `(pid ${pid})` : `(pid ${pid} start ${start})`
  return `${PREFIX} ${args.label} ${tail}`
}

export function parseWorktreeLockToken(reason: string): WorktreeLockIdentity | undefined {
  const matched = TOKEN.exec(reason.trim())
  if (matched === null) return undefined

  const pid = Number(matched[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined

  return { pid, start: matched[2] }
}

export function worktreeLockHolder(args: {
  reason: string | undefined
  ours: WorktreeLockIdentity
  holderIsLive: boolean
}): EWorktreeLockHolder {
  if (args.reason === undefined) return EWorktreeLockHolder.Absent

  const holder = parseWorktreeLockToken(args.reason)
  if (holder === undefined) return EWorktreeLockHolder.Foreign
  if (holder.pid === args.ours.pid && holder.start === args.ours.start) {
    return EWorktreeLockHolder.Ours
  }

  return args.holderIsLive ? EWorktreeLockHolder.LiveOther : EWorktreeLockHolder.Stale
}
