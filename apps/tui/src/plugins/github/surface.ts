import { useMemo, useSyncExternalStore } from 'react'

import type { LinkedPullRequest } from '@dltech/atlas-core'
import type { UrlOpener } from '@dltech/atlas-harness'

import { EFooterItemReach, type FooterItem } from '../../ui/footer-item'
import type { PluginProjection } from '../projection'
import type { PluginSurface, PluginSurfaceHook } from '../surface'
import { pullRequestChip, pullRequestFallbackChip } from './pull-request-pill'
import type { PullRequestService } from './pull-request-service'
import type { SessionFacts } from './session'
import { usePullRequest, type FooterPullRequest } from './use-pull-request'

export function pullRequestItem(args: {
  footer: FooterPullRequest | null
  onOpen: (url: string) => void
}): FooterItem | null {
  const { footer } = args
  if (footer === null) return null

  const chip =
    footer.badge === null
      ? pullRequestFallbackChip({ label: footer.label })
      : pullRequestChip(footer.badge)

  const first = chip.spans[0]
  const spans =
    footer.overflow === 0 || first === undefined
      ? chip.spans
      : [{ ...first, text: `${first.text} +${footer.overflow}` }, ...chip.spans.slice(1)]

  return {
    id: 'pr',
    spans,
    ground: chip.ground,
    reach: EFooterItemReach.Keyboard,
    onActivate: () => args.onOpen(footer.url),
  }
}

export const pullRequestSurface = (args: {
  service: PullRequestService
  facts: SessionFacts
  links: PluginProjection<readonly LinkedPullRequest[]>
  openUrl: UrlOpener
}): PluginSurfaceHook => {
  const { service, facts, links, openUrl } = args

  return (): PluginSurface => {
    useSyncExternalStore(facts.subscribe, facts.version)

    const linked = links.use()
    const { footer, section } = usePullRequest({
      service,
      projectDirectory: facts.directory(),
      working: facts.working(),
      linked,
      onOpen: openUrl,
    })

    const footerItem = useMemo(() => pullRequestItem({ footer, onOpen: openUrl }), [footer, openUrl])

    return useMemo(() => ({ footerItem, sidebarSection: section }), [footerItem, section])
  }
}
