import type { RecoveredAgents, UnloggedChild } from '@dltech/atlas-harness'

export type LostChildRow = {
  id: string
  name: string
  startedAt: string
}

const UNTITLED = 'an untitled sub-agent'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The title the child thread was opened under, which is the only name anything holds for it: the
 * parent's log has no `agent-spawned` to read an intent from, which is what makes it unlogged.
 */
export function lostChildName(child: Pick<UnloggedChild, 'title' | 'agentType'>): string {
  const titled = child.title === undefined ? '' : oneLine(child.title)
  if (titled !== '') return titled

  const typed = child.agentType === undefined ? '' : oneLine(child.agentType)
  return typed === '' ? UNTITLED : typed
}

export const lostChildRows = (lost: RecoveredAgents | null): readonly LostChildRow[] =>
  lost === null
    ? []
    : lost.unlogged.map((child) => ({
        id: child.agentId,
        name: lostChildName(child),
        startedAt: child.startedAt,
      }))

/**
 * Only the unlogged are named here. A child the last process merely failed to close out already
 * has an honest `agent-ended` in this conversation's log, written before the transcript was read,
 * so it is on screen with its turn and tool counts — saying it twice would bury the one case that
 * nothing else reports.
 */
export const hasLostChildren = (lost: RecoveredAgents | null): boolean =>
  lostChildRows(lost).length > 0

export const LOST_CHILDREN_TITLE = 'Sub-agents this conversation has no record of'

export const LOST_CHILDREN_EXPLANATION =
  'Opened by the last process, which died before it recorded that it had. They ran, and one part-way through a command may have changed files in this workspace — check the tree before you carry on.'

export const LOST_CHILDREN_UNREACHABLE =
  'Nothing here can be resumed: this conversation holds no record of them, so it cannot address them. Nothing was resumed for you.'

export const NOTHING_WAS_LOST = 'nothing was lost when this conversation was opened'

export const lostChildCount = (rows: readonly LostChildRow[]): string =>
  rows.length === 1 ? '1 sub-agent' : `${rows.length} sub-agents`

export const lostChildrenNotice = (lost: RecoveredAgents | null): string =>
  `${lostChildCount(lostChildRows(lost))} left no record in this conversation — /agents to view`
