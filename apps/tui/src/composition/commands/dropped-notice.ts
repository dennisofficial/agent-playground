const slashed = (names: readonly string[]): string => names.map((name) => `/${name}`).join(', ')

/**
 * A thread-swapping command discards whatever was queued behind it: messages were typed for the
 * conversation it replaces, and commands queued after it were meant for that same conversation.
 */
export function droppedNotice(args: {
  command: string
  messages: number
  commands: readonly string[]
}): string | null {
  const dropped: string[] = []
  if (args.messages === 1) dropped.push('a queued message')
  if (args.messages > 1) dropped.push(`${args.messages} queued messages`)
  if (args.commands.length > 0) dropped.push(slashed(args.commands))
  if (dropped.length === 0) return null

  return `/${args.command} dropped ${dropped.join(' and ')}`
}
