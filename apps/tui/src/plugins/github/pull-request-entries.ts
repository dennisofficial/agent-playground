import type { LinkedPullRequest } from '@dltech/atlas-core'

import { pullRequestLinkKey } from './links'
import {
  checkoutKey,
  EPullRequestLookup,
  type PullRequestReading,
  type RepositoryCheckout,
} from './pure'

export type PullRequestEntry = {
  key: string
  number: number
  url: string
  branch: string
  reading: PullRequestReading | null
  current: boolean
}

const foundOf = (reading: PullRequestReading | null) =>
  reading !== null && reading.lookup === EPullRequestLookup.Found ? reading : null

/**
 * The display list every surface reads: the durable links oldest first, with the checkout the
 * session currently stands on merged in. A tracked pull request that is linked already takes the
 * tracked reading — it is the fresher of the two polls — and one that is not linked yet sits at
 * the bottom as the latest, where `recordFound` will make it durable at turn end.
 */
export function pullRequestEntries(args: {
  linked: readonly LinkedPullRequest[]
  read: (key: string) => PullRequestReading
  current: { checkout: RepositoryCheckout; reading: PullRequestReading } | null
}): readonly PullRequestEntry[] {
  const current = args.current
  const currentFound = current === null ? null : foundOf(current.reading)
  const currentKey =
    currentFound === null || current === null
      ? null
      : pullRequestLinkKey({
          repo: `${current.checkout.remote.host}/${current.checkout.remote.owner}/${current.checkout.remote.repo}`,
          number: currentFound.pullRequest.number,
        })

  const entries: PullRequestEntry[] = args.linked.map((link) => {
    const key = pullRequestLinkKey(link)
    const isCurrent = key === currentKey && current !== null
    return {
      key,
      number: link.number,
      url: link.url,
      branch: link.branch,
      reading: isCurrent ? current.reading : args.read(key),
      current: isCurrent,
    }
  })

  if (current === null || currentFound === null || currentKey === null) return entries
  if (entries.some((entry) => entry.key === currentKey)) return entries

  return [
    ...entries,
    {
      key: checkoutKey(current.checkout),
      number: currentFound.pullRequest.number,
      url: currentFound.pullRequest.url,
      branch: current.checkout.branch,
      reading: current.reading,
      current: true,
    },
  ]
}
