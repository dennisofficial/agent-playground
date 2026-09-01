import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useState } from 'react'

import type { ContributedSurface, PluginSurface } from '../../plugins/surface'
import { EFooterItemReach, type FooterItem } from '../../ui/footer-item'
import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { ESidebarPlace, type SidebarSection } from '../../ui/sidebar-section'
import { usePluginSurfaces, type PluginSurfaces } from '../use-plugin-surfaces'

const RENDER_MS = 60

const pill = (id: string): FooterItem => ({
  id,
  spans: [{ text: id }],
  reach: EFooterItemReach.Keyboard,
})

const section = (args: { id: string; place: ESidebarPlace }): SidebarSection => ({
  id: args.id,
  place: args.place,
  rows: [{ id: `${args.id}-row`, spans: [{ text: args.id }] }],
})

const surface = (args: { pluginId: string; gives: PluginSurface }): ContributedSurface => ({
  pluginId: args.pluginId,
  use: () => args.gives,
})

const throwing = (pluginId: string): ContributedSurface => ({
  pluginId,
  use: () => {
    throw new Error(`${pluginId} blew up`)
  },
})

type Probe = {
  surfaces: PluginSurfaces | null
  setWidth: ((width: number) => void) | null
  caught: Error | null
}

const probed = (): Probe => ({ surfaces: null, setWidth: null, caught: null })

function Host(props: { surfaces: readonly ContributedSurface[]; probe: Probe }): React.ReactNode {
  props.probe.surfaces = usePluginSurfaces({ surfaces: props.surfaces })

  return <text>host</text>
}

function Narrowing(props: {
  surfaces: readonly ContributedSurface[]
  probe: Probe
}): React.ReactNode {
  const [width, setWidth] = useState(props.surfaces.length)
  props.probe.setWidth = setWidth

  return <Host surfaces={props.surfaces.slice(0, width)} probe={props.probe} />
}

class Boundary extends React.Component<
  { children: React.ReactNode; probe: Probe },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.probe.caught = error
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

async function mounted(node: React.ReactNode): Promise<{
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  const setup = await testRender(node, { width: 60, height: 8 })
  await setup.flush()

  return {
    flush: async () => {
      await settle(RENDER_MS)
      await setup.flush()
    },
    done: () => teardown(setup),
  }
}

const foundOf = (probe: Probe): PluginSurfaces => {
  if (probe.surfaces === null) throw new Error('the probe never mounted')
  return probe.surfaces
}

describe('usePluginSurfaces', () => {
  it('carries every contributed pill, in plugin-list order', async () => {
    const probe = probed()
    const { done } = await mounted(
      <Host
        probe={probe}
        surfaces={[
          surface({ pluginId: 'github', gives: { footerItem: pill('pr') } }),
          surface({ pluginId: 'shells', gives: { footerItem: pill('shells') } }),
        ]}
      />,
    )

    try {
      expect(foundOf(probe).footerItems.map((item) => item.id)).toEqual(['pr', 'shells'])
    } finally {
      await done()
    }
  })

  it('leaves the row alone for a plugin with nothing to say this render', async () => {
    const probe = probed()
    const { done } = await mounted(
      <Host
        probe={probe}
        surfaces={[
          surface({ pluginId: 'github', gives: { footerItem: null } }),
          surface({ pluginId: 'quiet', gives: {} }),
          surface({ pluginId: 'shells', gives: { footerItem: pill('shells') } }),
        ]}
      />,
    )

    try {
      expect(foundOf(probe).footerItems.map((item) => item.id)).toEqual(['shells'])
    } finally {
      await done()
    }
  })

  it('answers the same empty row when no plugin contributes anything', async () => {
    const probe = probed()
    const { done } = await mounted(
      <Host probe={probe} surfaces={[surface({ pluginId: 'quiet', gives: {} })]} />,
    )

    try {
      expect(foundOf(probe).footerItems).toEqual([])
      expect(foundOf(probe).sidebarSections).toEqual([])
    } finally {
      await done()
    }
  })

  it('keeps a throwing surface to itself, so the rest of the row still draws', async () => {
    const probe = probed()
    const { done } = await mounted(
      <Host
        probe={probe}
        surfaces={[
          throwing('broken'),
          surface({ pluginId: 'shells', gives: { footerItem: pill('shells') } }),
        ]}
      />,
    )

    try {
      expect(foundOf(probe).footerItems.map((item) => item.id)).toEqual(['shells'])
    } finally {
      await done()
    }
  })

  it('lays the facts a plugin contributes above the panels it contributes', async () => {
    const probe = probed()
    const { done } = await mounted(
      <Host
        probe={probe}
        surfaces={[
          surface({
            pluginId: 'panel',
            gives: { sidebarSection: section({ id: 'panel', place: ESidebarPlace.Panels }) },
          }),
          surface({
            pluginId: 'github',
            gives: { sidebarSection: section({ id: 'repo', place: ESidebarPlace.Facts }) },
          }),
        ]}
      />,
    )

    try {
      expect(foundOf(probe).sidebarSections.map((found) => found.id)).toEqual(['repo', 'panel'])
    } finally {
      await done()
    }
  })

  it('refuses a list that changes width, rather than corrupting the hook order', async () => {
    const probe = probed()
    const { flush, done } = await mounted(
      <Boundary probe={probe}>
        <Narrowing
          probe={probe}
          surfaces={[
            surface({ pluginId: 'github', gives: { footerItem: pill('pr') } }),
            surface({ pluginId: 'shells', gives: { footerItem: pill('shells') } }),
          ]}
        />
      </Boundary>,
    )

    try {
      expect(foundOf(probe).footerItems).toHaveLength(2)

      act(() => probe.setWidth?.(1))
      await flush()

      expect(probe.caught?.message).toContain('2 to 1')
    } finally {
      await done()
    }
  })
})
