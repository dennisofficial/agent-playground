import type { LinkedPullRequest } from '@dltech/atlas-core'

import { probeCheckout } from '../plugins/github/checkout-probe'
import { pullRequestChip } from '../plugins/github/pull-request-pill'
import {
  checkoutKey,
  EPullRequestLookup,
  pullRequestBadge,
  type PullRequestPort,
  type PullRequestReading,
  type RepositoryCheckout,
} from '../plugins/github/pure'
import { theme } from '../ui/theme'
import type { ThreadChip, ThreadRow } from '../ui/threads-model'

export type CheckoutProbe = (args: { directory: string }) => Promise<RepositoryCheckout | null>

const MUTED: Pick<ThreadChip, 'ground' | 'ink'> = { ground: theme.selectedBg, ink: theme.body }

/**
 * A linked pull request keeps its chip even when its state cannot be read — the link itself is a
 * fact the log recorded, so the chip goes muted rather than vanishing. The probed checkout follows
 * the older rule instead: a branch with no pull request draws no chip at all.
 */
const chipFrom = (args: { label: string; reading: PullRequestReading }): ThreadChip => {
  if (args.reading.lookup !== EPullRequestLookup.Found) {
    return { label: args.label, ...MUTED }
  }

  const drawn = pullRequestChip(pullRequestBadge(args.reading.pullRequest))
  return { label: args.label, ground: drawn.ground, ink: drawn.spans[0]?.fg ?? theme.body }
}

const identityOf = (checkout: RepositoryCheckout, number: number): string =>
  `${checkout.remote.host}/${checkout.remote.owner}/${checkout.remote.repo}#${number}`

const linkedChips = async (args: {
  links: readonly LinkedPullRequest[]
  pullRequests: PullRequestPort
}): Promise<{ chips: ThreadChip[]; identities: Set<string> }> => {
  const chips: ThreadChip[] = []
  const identities = new Set<string>()

  for (const link of args.links) {
    identities.add(`${link.repo}#${link.number}`)
    const label = `#${link.number}`
    try {
      const reading = await args.pullRequests.readLinked({ repo: link.repo, number: link.number })
      chips.push(chipFrom({ label, reading }))
    } catch {
      chips.push({ label, ...MUTED })
    }
  }

  return { chips, identities }
}

/**
 * The pills of one picker opening. Threads sharing a checkout — every thread standing in the main
 * tree shares one — answer with one read, so the reads key on the checkout rather than the row.
 * Nothing here may throw: a pill is decoration, and a rejected probe must not take the listing down.
 */
export async function threadChips(args: {
  rows: readonly ThreadRow[]
  home: string
  pullRequests: PullRequestPort
  probe?: CheckoutProbe
}): Promise<Map<string, readonly ThreadChip[]>> {
  const askGit = args.probe ?? probeCheckout
  const directoryOf = (row: ThreadRow): string => row.worktree?.path ?? args.home

  const byDirectory = new Map<string, RepositoryCheckout | null>()
  await Promise.all(
    [...new Set(args.rows.map(directoryOf))].map(async (directory) => {
      try {
        byDirectory.set(directory, await askGit({ directory }))
      } catch {
        byDirectory.set(directory, null)
      }
    }),
  )

  const checkouts = new Map<string, RepositoryCheckout>()
  for (const checkout of byDirectory.values()) {
    if (checkout !== null) checkouts.set(checkoutKey(checkout), checkout)
  }

  const readingsByCheckout = new Map<string, PullRequestReading>()
  await Promise.all(
    [...checkouts.entries()].map(async ([key, checkout]) => {
      try {
        readingsByCheckout.set(key, await args.pullRequests.read({ checkout }))
      } catch {
        // A port is allowed to reject; the row simply keeps no pill.
      }
    }),
  )

  const byThread = new Map<string, readonly ThreadChip[]>()
  await Promise.all(
    args.rows.map(async (row) => {
      const { chips, identities } = await linkedChips({
        links: row.pullRequests ?? [],
        pullRequests: args.pullRequests,
      })

      const checkout = byDirectory.get(directoryOf(row))
      if (checkout !== null && checkout !== undefined) {
        const reading = readingsByCheckout.get(checkoutKey(checkout))
        if (reading !== undefined && reading.lookup === EPullRequestLookup.Found) {
          const identity = identityOf(checkout, reading.pullRequest.number)
          if (!identities.has(identity)) {
            chips.push(chipFrom({ label: `#${reading.pullRequest.number}`, reading }))
          }
        }
      }

      if (chips.length > 0) byThread.set(row.threadId, chips)
    }),
  )
  return byThread
}
