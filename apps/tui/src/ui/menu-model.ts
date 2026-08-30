export const MENU_ROWS = 8

export type MenuWindow<T> = {
  start: number
  visible: readonly T[]
}

export function movedIndex(args: { index: number; count: number; delta: number }): number {
  if (args.count === 0) return args.index

  const steps = Math.trunc(args.delta)
  if (steps === 0) return args.index

  return (((args.index + steps) % args.count) + args.count) % args.count
}

export function menuWindow<T>(args: {
  entries: readonly T[]
  index: number
  rows: number
}): MenuWindow<T> {
  const rows = Math.max(1, Math.trunc(args.rows))
  const count = args.entries.length
  if (count <= rows) return { start: 0, visible: args.entries }

  const start = Math.min(Math.max(0, args.index - rows + 1), count - rows)
  return { start, visible: args.entries.slice(start, start + rows) }
}
