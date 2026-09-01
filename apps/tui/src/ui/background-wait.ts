import { formatElapsed } from './theme'

export type BackgroundWork = {
  agents: number
  shells: number
}

export const NOTHING_IN_BACKGROUND: BackgroundWork = { agents: 0, shells: 0 }

export const isWaiting = (work: BackgroundWork): boolean => work.agents + work.shells > 0

const tally = (args: { count: number; noun: string }): string =>
  `${args.count} ${args.noun}${args.count === 1 ? '' : 's'}`

const WAITED_SEPARATOR = ' · '

/**
 * The elapsed reading is how long the harness has been idle on this work, not how long the work
 * has been running: a shell started three turns ago is only being waited on from the moment the
 * turn settled with nothing left to do but hear back from it.
 */
export function backgroundWaitLabel(args: {
  work: BackgroundWork
  waitedMs?: number | undefined
}): string | null {
  const tallies = [
    args.work.agents > 0 ? tally({ count: args.work.agents, noun: 'background agent' }) : null,
    args.work.shells > 0 ? tally({ count: args.work.shells, noun: 'shell' }) : null,
  ].filter((part): part is string => part !== null)

  if (tallies.length === 0) return null

  const waited =
    args.waitedMs === undefined ? '' : `${WAITED_SEPARATOR}${formatElapsed(args.waitedMs)}`

  return `Waiting for ${tallies.join(' and ')} to finish${waited}`
}
