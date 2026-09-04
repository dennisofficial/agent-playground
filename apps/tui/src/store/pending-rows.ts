import {
  ENotice,
  EShellStatus,
  type AgentSnapshot,
  type PendingShellNotice,
  type ServiceSnapshot,
} from '@dltech/atlas-harness'

import { agentEndedLine, agentEndingFailed } from './agent-ended-line'
import type { PendingMessage } from './pending-queue'
import { serviceEndedLine, serviceEndingFailed } from './service-ended-line'
import {
  shellAwaitingInputLine,
  shellEndedLine,
  shellEndingFailed,
  shellMatchedNoticeLine,
  shellStillRunningLine,
} from './shell-ended-line'

export enum EPendingKind {
  Operator = 'operator',
  BackgroundShell = 'background-shell',
  Agent = 'agent',
  Service = 'service',
}

export type PendingRow =
  | { kind: EPendingKind.Operator; id: string; text: string; taken: boolean }
  | { kind: EPendingKind.BackgroundShell; id: string; text: string; failed: boolean }
  | { kind: EPendingKind.Agent; id: string; text: string; failed: boolean }
  | { kind: EPendingKind.Service; id: string; text: string; failed: boolean }

const NOTHING_PENDING: readonly PendingRow[] = Object.freeze([])

/**
 * A shell ending waits in the same place as a queued message but is not one: nobody typed it, so it
 * cannot be edited or taken back, and the take-back affordance must never land on it.
 */
/**
 * A notice queued while the shell is still running is a prompt it cannot be answered out of, or a
 * check-in that needs no answer at all - never an ending: reading one as one would announce that a
 * shell nobody stopped had finished.
 */
function pendingShellRow(notice: PendingShellNotice): PendingRow {
  const { snapshot } = notice

  if (notice.kind === ENotice.StillRunning) {
    return {
      kind: EPendingKind.BackgroundShell,
      id: `shell-still-running-${snapshot.shellId}`,
      text: shellStillRunningLine(snapshot),
      failed: false,
    }
  }

  if (notice.kind === ENotice.Matched) {
    return {
      kind: EPendingKind.BackgroundShell,
      id: `shell-matched-${snapshot.shellId}`,
      text: shellMatchedNoticeLine(snapshot),
      failed: false,
    }
  }

  if (snapshot.status === EShellStatus.Running) {
    return {
      kind: EPendingKind.BackgroundShell,
      id: `shell-awaiting-${snapshot.shellId}`,
      text: shellAwaitingInputLine(snapshot),
      failed: true,
    }
  }

  return {
    kind: EPendingKind.BackgroundShell,
    id: `shell-ended-${snapshot.shellId}`,
    text: shellEndedLine(snapshot),
    failed: shellEndingFailed(snapshot),
  }
}

function pendingAgentRow(notice: AgentSnapshot): PendingRow {
  return {
    kind: EPendingKind.Agent,
    id: `agent-${notice.status}-${notice.agentId}`,
    text: agentEndedLine(notice),
    failed: agentEndingFailed(notice),
  }
}

function pendingServiceRow(notice: ServiceSnapshot): PendingRow {
  return {
    kind: EPendingKind.Service,
    id: `service-${notice.status}-${notice.serviceId}`,
    text: serviceEndedLine(notice),
    failed: serviceEndingFailed(notice),
  }
}

export function pendingRows(args: {
  messages: readonly PendingMessage[]
  notices: readonly PendingShellNotice[]
  agents: readonly AgentSnapshot[]
  services: readonly ServiceSnapshot[]
}): readonly PendingRow[] {
  const { agents, services } = args
  if (
    args.messages.length === 0 &&
    args.notices.length === 0 &&
    agents.length === 0 &&
    services.length === 0
  ) {
    return NOTHING_PENDING
  }

  return [
    ...args.messages.map(
      (message): PendingRow => ({
        kind: EPendingKind.Operator,
        id: message.id,
        text: message.text,
        taken: message.taken,
      }),
    ),
    ...args.notices.map((notice): PendingRow => pendingShellRow(notice)),
    ...agents.map((notice): PendingRow => pendingAgentRow(notice)),
    ...services.map((notice): PendingRow => pendingServiceRow(notice)),
  ]
}
