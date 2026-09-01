import { type EventDraft } from '@dltech/atlas-core'

import type { ShellSnapshot } from './background-shell'
import type { ShellDelta } from './shell-registry'

export function endedDraft(args: { snapshot: ShellSnapshot; delta: ShellDelta }): EventDraft {
  const { snapshot, delta } = args

  return {
    type: 'background-shell-ended',
    shellId: snapshot.shellId,
    command: snapshot.command,
    description: snapshot.description,
    status: snapshot.status,
    killedBy: snapshot.killedBy,
    exitCode: snapshot.exitCode,
    output: delta.text,
    droppedCharacters: delta.droppedCharacters,
    remainingCharacters: delta.remainingCharacters,
  }
}

export function awaitingInputDraft(args: {
  snapshot: ShellSnapshot
  delta: ShellDelta
}): EventDraft {
  const { snapshot, delta } = args

  return {
    type: 'background-shell-awaiting-input',
    shellId: snapshot.shellId,
    command: snapshot.command,
    description: snapshot.description,
    output: delta.text,
    droppedCharacters: delta.droppedCharacters,
    remainingCharacters: delta.remainingCharacters,
  }
}
