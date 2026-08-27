import type { EventOfType } from '../../events/envelope'
import { shellLabel } from '../../shells/label'
import { shellEnding } from '../../shells/status'

const OPEN = '<background-shell-ended>'
const CLOSE = '</background-shell-ended>'

const PRINTED_NOTHING = 'It printed nothing.'

const droppedNote = (characters: number): string =>
  `[${characters} characters were lost before this point: the shell printed faster than it was read.]`

const remainingNote = (args: { characters: number; shellId: string }): string =>
  `[${args.characters} more characters are waiting — call shell_output({ shellId: "${args.shellId}" }) for the rest.]`

export function backgroundShellBlock(event: EventOfType<'background-shell-ended'>): string {
  const headline = `Background shell ${event.shellId} ${shellLabel(event)} ${shellEnding(event)}. Everything it printed follows; it has not been read yet.`

  const sections = [headline]

  if (event.droppedCharacters > 0) sections.push(droppedNote(event.droppedCharacters))

  sections.push(event.output.trimEnd() === '' ? PRINTED_NOTHING : event.output.trimEnd())

  if (event.remainingCharacters > 0) {
    sections.push(remainingNote({ characters: event.remainingCharacters, shellId: event.shellId }))
  }

  return [OPEN, sections.join('\n\n'), CLOSE].join('\n')
}
