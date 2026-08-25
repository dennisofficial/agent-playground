import type { Rule } from './rule'
import { messagesFromEvents } from './rules/messages-from-events'
import { systemPreamble } from './rules/system-preamble'

export function defaultRules(): readonly Rule[] {
  return [systemPreamble(), messagesFromEvents()]
}
