import { useMemo, useSyncExternalStore } from 'react'

import type { UrlOpener } from '@dltech/atlas-harness'

import { EFooterItemReach, type FooterItem } from '../../ui/footer-item'
import type { PluginSurface, PluginSurfaceHook } from '../surface'
import type { PullRequestBadge } from './pure'
import { pullRequestPill } from './pull-request-pill'
import type { PullRequestService } from './pull-request-service'
import type { SessionFacts } from './session'
import { usePullRequest } from './use-pull-request'

export function pullRequestItem(args: {
  badge: PullRequestBadge | null
  onOpen: (url: string) => void
}): FooterItem | null {
  const { badge } = args
  if (badge === null) return null

  return {
    id: 'pr',
    spans: pullRequestPill(badge),
    reach: EFooterItemReach.Keyboard,
    onActivate: () => args.onOpen(badge.url),
  }
}

export const pullRequestSurface = (args: {
  service: PullRequestService
  facts: SessionFacts
  openUrl: UrlOpener
}): PluginSurfaceHook => {
  const { service, facts, openUrl } = args

  return (): PluginSurface => {
    useSyncExternalStore(facts.subscribe, facts.version)

    const { badge, section } = usePullRequest({
      service,
      projectDirectory: facts.directory(),
      working: facts.working(),
      onOpen: openUrl,
    })

    const footerItem = useMemo(() => pullRequestItem({ badge, onOpen: openUrl }), [badge, openUrl])

    return useMemo(() => ({ footerItem, sidebarSection: section }), [footerItem, section])
  }
}
