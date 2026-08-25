export function isPinnedToBottom(args: {
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
}): boolean {
  const furthest = Math.max(0, args.scrollHeight - args.viewportHeight)
  return args.scrollTop >= furthest
}
