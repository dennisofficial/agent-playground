import type { EventOfType } from '../../events/envelope'
import { serviceEnding } from '../../services/status'
import { shellLabel } from '../../shells/label'
import { EKilledBy } from '../../shells/status'

const OPEN = '<service-ended>'
const CLOSE = '</service-ended>'

const PRINTED_NOTHING = 'Its log is empty.'

const USER_KILLED =
  'The user stopped this service deliberately. Nothing is wrong; do not restart it or work around it unless the user asks.'

const NOT_WORK =
  'This was infrastructure you work against, not work you were waiting on. Its full log is at the path above; read it with the read tool if you need more than the tail.'

export function serviceEndedBlock(event: EventOfType<'service-ended'>): string {
  const headline = `Service ${event.serviceId} ${shellLabel(event)} ${serviceEnding(event)}. Its log is at ${event.logPath}.`

  const sections = [headline]

  if (event.killedBy === EKilledBy.User) sections.push(USER_KILLED)

  sections.push(event.tail.trimEnd() === '' ? PRINTED_NOTHING : event.tail.trimEnd())

  sections.push(NOT_WORK)

  return [OPEN, sections.join('\n\n'), CLOSE].join('\n')
}
