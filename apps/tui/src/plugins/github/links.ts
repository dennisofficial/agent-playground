import {
  pullRequestsOf,
  type AfterTurn,
  type LinkedPullRequest,
  type OnThreadOpen,
} from '@dltech/atlas-core'

import { defineProjection, type PluginProjection } from '../projection'
import { EPullRequestLookup, type RepositoryCheckout } from './pure'
import type { PullRequestService } from './pull-request-service'

export type PullRequestLinks = {
  projection: PluginProjection<readonly LinkedPullRequest[]>
  recordFound: AfterTurn
  forgetThread: OnThreadOpen
}

export const pullRequestLinkKey = (link: { repo: string; number: number }): string =>
  `${link.repo}#${link.number}`

const repoOf = (checkout: RepositoryCheckout): string =>
  `${checkout.remote.host}/${checkout.remote.owner}/${checkout.remote.repo}`

const sameLinks = (
  left: readonly LinkedPullRequest[],
  right: readonly LinkedPullRequest[],
): boolean =>
  left.length === right.length &&
  left.every((link, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      pullRequestLinkKey(link) === pullRequestLinkKey(other) &&
      link.branch === other.branch &&
      link.url === other.url
    )
  })

/**
 * The durable half of the pull request story. `recordFound` writes the link: at turn end it takes
 * the tracked checkout's latest reading and drafts the event, so the log accumulates one row per
 * pull request the session has stood on. `projection` reads them back for the surfaces. The
 * `drafted` set bridges the gap between the two — a draft is not in the fold until the next read
 * publishes it, and without the bridge every turn boundary in between would draft it again.
 */
export function createPullRequestLinks(args: { service: PullRequestService }): PullRequestLinks {
  const drafted = new Set<string>()

  let folded: readonly LinkedPullRequest[] = []
  const projection = defineProjection<readonly LinkedPullRequest[]>({
    id: 'pull-requests',
    fold: ({ events }) => {
      const next = pullRequestsOf(events)
      if (sameLinks(folded, next)) return folded

      folded = next
      return next
    },
  })

  return {
    projection,
    recordFound: async () => {
      const found = args.service.current()
      if (found === null) return {}
      if (found.reading.lookup !== EPullRequestLookup.Found) return {}

      const repo = repoOf(found.checkout)
      const { number, url } = found.reading.pullRequest
      const identity = pullRequestLinkKey({ repo, number })
      const durable = projection.current().some((link) => pullRequestLinkKey(link) === identity)
      if (durable || drafted.has(identity)) return {}

      drafted.add(identity)
      return {
        drafts: [
          { type: 'pull-request-linked', number, url, repo, branch: found.checkout.branch },
        ],
      }
    },
    forgetThread: async () => {
      drafted.clear()
      return {}
    },
  }
}
