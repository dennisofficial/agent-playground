const OFFERED_AT_MOST = 8

export type ModelOffer = {
  offered: readonly string[]
  withheld: number
}

const sharedPrefix = ({ left, right }: { left: string; right: string }): number => {
  const shortest = Math.min(left.length, right.length)
  let at = 0
  while (at < shortest && left[at] === right[at]) at += 1
  return at
}

const closeness = ({ candidate, typed }: { candidate: string; typed: string }): number => {
  const one = candidate.toLowerCase()
  const other = typed.toLowerCase()
  if (one.includes(other) || other.includes(one)) return Number.MAX_SAFE_INTEGER

  return sharedPrefix({ left: one, right: other })
}

export function modelsWorthOffering(args: {
  modelId: string
  reachable: readonly string[]
}): ModelOffer {
  const ranked = args.reachable
    .map((candidate, at) => ({ candidate, at, near: closeness({ candidate, typed: args.modelId }) }))
    .sort((left, right) => right.near - left.near || left.at - right.at)
    .map((entry) => entry.candidate)

  return {
    offered: ranked.slice(0, OFFERED_AT_MOST),
    withheld: Math.max(0, ranked.length - OFFERED_AT_MOST),
  }
}

export function offerSentence(args: {
  offer: ModelOffer
  lead: string
  whenNothingIsReachable: string
  then?: string | undefined
}): string {
  const { offered, withheld } = args.offer
  if (offered.length === 0) return args.whenNothingIsReachable

  const more = withheld === 0 ? '' : `, and ${withheld} more`
  const tail = args.then === undefined ? '' : ` ${args.then}`
  return `${args.lead} ${offered.join(', ')}${more}.${tail}`
}
