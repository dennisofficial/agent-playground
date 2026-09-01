import type { EventOfType } from '../../events/envelope'
import { shellLabel } from '../../shells/label'
import { EKilledBy, shellEnding } from '../../shells/status'

const OPEN = '<background-shell-ended>'
const CLOSE = '</background-shell-ended>'

const AWAITING_OPEN = '<background-shell-awaiting-input>'
const AWAITING_CLOSE = '</background-shell-awaiting-input>'

const PRINTED_NOTHING = 'It printed nothing.'

const USER_KILLED =
  'The user stopped this shell deliberately. Nothing is wrong; do not restart it, work around it, or spend another run reproducing what it was doing unless the user asks.'

const droppedNote = (characters: number): string =>
  `[${characters} characters were lost before this point: the shell printed faster than it was read.]`

const remainingNote = (args: { characters: number; shellId: string }): string =>
  `[${args.characters} more characters are waiting — call shell_output({ shellId: "${args.shellId}" }) for the rest.]`

export function backgroundShellBlock(event: EventOfType<'background-shell-ended'>): string {
  const headline = `Background shell ${event.shellId} ${shellLabel(event)} ${shellEnding(event)}. Everything it printed follows; it has not been read yet.`

  const sections = [headline]

  if (event.killedBy === EKilledBy.User) sections.push(USER_KILLED)

  if (event.droppedCharacters > 0) sections.push(droppedNote(event.droppedCharacters))

  sections.push(event.output.trimEnd() === '' ? PRINTED_NOTHING : event.output.trimEnd())

  if (event.remainingCharacters > 0) {
    sections.push(remainingNote({ characters: event.remainingCharacters, shellId: event.shellId }))
  }

  return [OPEN, sections.join('\n\n'), CLOSE].join('\n')
}

const AWAITING_HOW_TO_CLEAR =
  'Kill it with shell_kill and start it again with its input piped in, or run it a way that does not ask. Waiting changes nothing: no ending is coming.'

export function backgroundShellAwaitingInputBlock(
  event: EventOfType<'background-shell-awaiting-input'>,
): string {
  const headline = `Background shell ${event.shellId} ${shellLabel(event)} is waiting on input. Its stdin is closed, so nothing can answer it and it will never end on its own. Everything it has printed that you have not seen follows.`

  const sections = [headline]

  if (event.droppedCharacters > 0) sections.push(droppedNote(event.droppedCharacters))

  sections.push(event.output.trimEnd() === '' ? PRINTED_NOTHING : event.output.trimEnd())

  if (event.remainingCharacters > 0) {
    sections.push(remainingNote({ characters: event.remainingCharacters, shellId: event.shellId }))
  }

  sections.push(AWAITING_HOW_TO_CLEAR)

  return [AWAITING_OPEN, sections.join('\n\n'), AWAITING_CLOSE].join('\n')
}
