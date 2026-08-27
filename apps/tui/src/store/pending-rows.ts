import type { ShellSnapshot } from '@dltech/atlas-harness'

import type { PendingMessage } from './pending-queue'
import { shellEndedLine, shellEndingFailed } from './shell-ended-line'

export enum EPendingKind {
  Operator = 'operator',
  BackgroundShell = 'background-shell',
}

export type PendingRow =
  | { kind: EPendingKind.Operator; id: string; text: string; taken: boolean }
  | { kind: EPendingKind.BackgroundShell; id: string; text: string; failed: boolean }

const NOTHING_PENDING: readonly PendingRow[] = Object.freeze([])

/**
 * A shell ending waits in the same place as a queued message but is not one: nobody typed it, so it
 * cannot be edited or taken back, and the take-back affordance must never land on it.
 */
export function pendingRows(args: {
  messages: readonly PendingMessage[]
  notices: readonly ShellSnapshot[]
}): readonly PendingRow[] {
  if (args.messages.length === 0 && args.notices.length === 0) return NOTHING_PENDING

  return [
    ...args.messages.map(
      (message): PendingRow => ({
        kind: EPendingKind.Operator,
        id: message.id,
        text: message.text,
        taken: message.taken,
      }),
    ),
    ...args.notices.map(
      (notice): PendingRow => ({
        kind: EPendingKind.BackgroundShell,
        id: `shell-ended-${notice.shellId}`,
        text: shellEndedLine(notice),
        failed: shellEndingFailed(notice),
      }),
    ),
  ]
}
