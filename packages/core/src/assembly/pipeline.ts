import type { Rule } from './rule'
import { messagesFromEvents } from './rules/messages-from-events'
import { systemPreamble, type PreambleWorkspace } from './rules/system-preamble'

export function defaultRules(workspace?: PreambleWorkspace): readonly Rule[] {
  return [systemPreamble(workspace), messagesFromEvents()]
}
