import { type EventDraft } from '@dltech/atlas-core'

import type { ShellSnapshot } from './background-shell'
import type { ShellDelta } from './notice-queue'
import type { MatchedLines } from './shell-watch'

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

export function matchedDraft(args: {
  snapshot: ShellSnapshot
  pattern: string
  matched: MatchedLines
}): EventDraft {
  const { snapshot, matched } = args

  return {
    type: 'background-shell-matched',
    shellId: snapshot.shellId,
    command: snapshot.command,
    description: snapshot.description,
    pattern: args.pattern,
    lines: matched.lines.join('\n'),
    matchCount: matched.matchCount,
    watchDisarmed: matched.disarmed ? true : undefined,
  }
}
