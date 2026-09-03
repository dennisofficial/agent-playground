import { EMessageOrigin, saidBy } from '../events/body'
import type { Event } from '../events/envelope'

export function tldrAnchor(events: readonly Event[]): number | undefined {
  return events.findLast(
    (event) => event.type === 'user-said' && saidBy(event) === EMessageOrigin.Operator,
  )?.seq
}
