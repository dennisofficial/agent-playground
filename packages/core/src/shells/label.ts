const QUOTED_COMMAND_CHARACTERS = 120

const ELLIPSIS = '…'

export function quotedShellCommand(command: string): string {
  const single = command.replace(/\s+/g, ' ').trim()
  const shown =
    single.length <= QUOTED_COMMAND_CHARACTERS
      ? single
      : `${single.slice(0, QUOTED_COMMAND_CHARACTERS)}${ELLIPSIS}`
  return `\`${shown}\``
}

export function shellLabel(args: { command: string; description?: string | undefined }): string {
  const quoted = quotedShellCommand(args.command)
  const named = args.description?.trim() ?? ''
  return named === '' ? quoted : `"${named}" (${quoted})`
}
