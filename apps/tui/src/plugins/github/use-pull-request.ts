import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { useShimmerClock } from '../../ui/hooks/use-shimmer-clock'
import { SPINNER_FRAME_MS, theme } from '../../ui/theme'
import { ESidebarPlace, type SidebarSection, type SidebarSectionRow } from '../surface'
import { probeCheckout } from './checkout-probe'
import {
  checkoutKey,
  EPullRequestLookup,
  pullRequestBadge,
  type PullRequestBadge,
  type RepositoryCheckout,
} from './pure'
import { pullRequestRow } from './pull-request-row'
import type { PullRequestService } from './pull-request-service'

export type PullRequestControl = {
  badge: PullRequestBadge | null
  section: SidebarSection | null
}

export type CheckoutProbe = (args: { directory: string }) => Promise<RepositoryCheckout | null>

const sameCheckout = (
  left: RepositoryCheckout | null,
  right: RepositoryCheckout | null,
): boolean => {
  if (left === null || right === null) return left === right

  return left.directory === right.directory && checkoutKey(left) === checkoutKey(right)
}

/**
 * The branch is probed rather than read off the log, and it is re-probed when the turn ends: a
 * `git checkout -b` inside a worktree changes the branch without changing the project directory,
 * so the directory effect alone would miss it.
 *
 * Every probe is disowned by its effect's cleanup, because two `git` calls started against
 * different directories can land in either order and the loser would otherwise re-track the
 * directory the session has already left.
 */
export function usePullRequest(args: {
  service: PullRequestService
  projectDirectory: string
  working: boolean
  onOpen: (url: string) => void
  probe?: CheckoutProbe
}): PullRequestControl {
  const { service, projectDirectory, working, onOpen } = args
  const askGit = args.probe ?? probeCheckout
  const [checkout, setCheckout] = useState<RepositoryCheckout | null>(null)

  useSyncExternalStore(service.subscribe, service.version)

  const probe = useCallback(
    async (owned: () => boolean): Promise<void> => {
      const probed = await askGit({ directory: projectDirectory })
      if (!owned()) return

      setCheckout((current) => (sameCheckout(current, probed) ? current : probed))
      if (probed === null) {
        service.stopTracking()
        return
      }

      service.track({ checkout: probed })
    },
    [askGit, projectDirectory, service],
  )

  useEffect(() => {
    let owned = true
    void probe(() => owned)

    return () => {
      owned = false
    }
  }, [probe])

  const turnWasRunning = useRef(false)
  useEffect(() => {
    const ended = turnWasRunning.current && !working
    turnWasRunning.current = working
    if (!ended) return

    let owned = true
    void probe(() => owned)

    return () => {
      owned = false
    }
  }, [probe, working])

  const reading = checkout === null ? null : service.snapshot({ key: checkoutKey(checkout) })
  const pullRequest =
    reading !== null && reading.lookup === EPullRequestLookup.Found ? reading.pullRequest : null

  const badge = useMemo(
    () => (pullRequest === null ? null : pullRequestBadge(pullRequest)),
    [pullRequest],
  )

  const now = useShimmerClock({
    active: (pullRequest?.tally.running ?? 0) > 0,
    intervalMs: SPINNER_FRAME_MS,
  })

  const section = useMemo((): SidebarSection | null => {
    const rows: SidebarSectionRow[] = []

    if (checkout !== null) {
      rows.push({ id: 'branch', spans: [{ text: checkout.branch, fg: theme.hover }] })
    }
    if (pullRequest !== null) {
      rows.push({
        id: 'pull-request',
        spans: pullRequestRow({ pullRequest, now }),
        onActivate: () => onOpen(pullRequest.url),
      })
    }
    if (rows.length === 0) return null

    return { id: 'github', place: ESidebarPlace.Facts, rows }
  }, [checkout, now, onOpen, pullRequest])

  return useMemo(() => ({ badge, section }), [badge, section])
}
