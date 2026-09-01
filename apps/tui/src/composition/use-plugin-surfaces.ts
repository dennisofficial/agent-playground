import { useEffect, useMemo, useRef } from 'react'

import { SURFACES_NOTHING, type ContributedSurface, type PluginSurface } from '../plugins/surface'
import { NO_FOOTER_ITEMS, type FooterItem } from '../ui/footer-item'
import { ENoticeTone, notify } from '../ui/notice-store'
import { NO_SIDEBAR_SECTIONS, orderSections, type SidebarSection } from '../ui/sidebar-section'

export type PluginSurfaces = {
  footerItems: readonly FooterItem[]
  sidebarSections: readonly SidebarSection[]
}

export const NO_PLUGIN_SURFACES: PluginSurfaces = {
  footerItems: NO_FOOTER_ITEMS,
  sidebarSections: NO_SIDEBAR_SECTIONS,
}

const foldSurfaces = (gathered: readonly PluginSurface[]): PluginSurfaces => {
  const footerItems = gathered
    .map((surface) => surface.footerItem ?? null)
    .filter((item): item is FooterItem => item !== null)
  const sidebarSections = orderSections(
    gathered
      .map((surface) => surface.sidebarSection ?? null)
      .filter((section): section is SidebarSection => section !== null),
  )

  if (footerItems.length === 0 && sidebarSections.length === 0) return NO_PLUGIN_SURFACES

  return {
    footerItems: footerItems.length === 0 ? NO_FOOTER_ITEMS : footerItems,
    sidebarSections,
  }
}

/**
 * Plugins load once, before the first render, so calling every contributed hook in a fixed order
 * obeys the Rules of Hooks. A list that changes width afterwards would silently shift each hook's
 * slot in React's per-component order, so it is caught here rather than corrupting the next render.
 */
export function usePluginSurfaces(args: {
  surfaces: readonly ContributedSurface[]
}): PluginSurfaces {
  const { surfaces } = args
  const width = useRef(surfaces.length)

  if (width.current !== surfaces.length) {
    throw new Error(
      `plugin surfaces went from ${width.current} to ${surfaces.length} after the first render`,
    )
  }

  const broken: string[] = []
  const gathered = surfaces.map((surface) => {
    try {
      return surface.use()
    } catch {
      broken.push(surface.pluginId)
      return SURFACES_NOTHING
    }
  })

  const failed = broken.join(', ')
  useEffect(() => {
    if (failed === '') return

    notify({ text: `surface failed: ${failed}`, tone: ENoticeTone.Warn })
  }, [failed])

  return useMemo(() => foldSurfaces(gathered), gathered)
}
