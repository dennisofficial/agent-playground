import { testRender } from '@opentui/react/test-utils'
import { beforeEach, describe, expect, it } from 'bun:test'
import React, { useState } from 'react'

import { letTimersRun } from '../../__tests__/ticking'
import { frameSettled } from '../../__tests__/waiting'
import { useShimmerClock } from '../use-shimmer-clock'

const FRAME_MS = 40

const SLACK = 2

const renders = new Map<string, number>()

const seen = new Map<string, number[]>()

function Shimmering(props: { label: string; active?: boolean }): React.ReactNode {
  const now = useShimmerClock({ active: props.active ?? true })
  renders.set(props.label, (renders.get(props.label) ?? 0) + 1)
  seen.set(props.label, [...(seen.get(props.label) ?? []), now])
  return <text>{`${props.label} ${now}`}</text>
}

type Probe = { hide: (() => void) | null }

function Hideable(props: { probe: Probe }): React.ReactNode {
  const [shown, setShown] = useState(true)
  props.probe.hide = () => setShown(false)
  return shown ? <Shimmering label="hideable" /> : <text>gone</text>
}

const mounted = async (node: React.ReactNode) => {
  const setup = await testRender(<box flexDirection="column">{node}</box>, { width: 40, height: 6 })
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  await setup.flush()
  return setup
}

const ticksOf = (label: string): number => (renders.get(label) ?? 1) - 1

describe('the shared shimmer clock', () => {
  beforeEach(() => {
    renders.clear()
    seen.clear()
  })

  it('draws one frame per tick however many components are shimmering', async () => {
    const setup = await mounted(
      <>
        <Shimmering label="first" />
        <Shimmering label="second" />
      </>,
    )
    try {
      renders.clear()
      const before = setup.renderer.getStats().frameCount

      const { elapsedMs } = await letTimersRun({ setup, ms: 500 })

      const frames = setup.renderer.getStats().frameCount - before
      const expected = Math.floor(elapsedMs / FRAME_MS)
      expect(ticksOf('first')).toBe(ticksOf('second'))
      expect(ticksOf('first')).toBeGreaterThanOrEqual(expected - SLACK)
      expect(Math.abs(frames - ticksOf('first'))).toBeLessThanOrEqual(SLACK)
      expect(frames).toBeLessThan(2 * ticksOf('first') - SLACK)
    } finally {
      setup.renderer.destroy()
    }
  })

  it('hands every subscriber the same instant', async () => {
    const setup = await mounted(
      <>
        <Shimmering label="first" />
        <Shimmering label="second" />
      </>,
    )
    try {
      seen.clear()
      await letTimersRun({ setup, ms: 200 })

      expect(seen.get('first')).toEqual(seen.get('second'))
    } finally {
      setup.renderer.destroy()
    }
  })

  it('stops ticking once the last subscriber has gone', async () => {
    const probe: Probe = { hide: null }
    const setup = await mounted(<Hideable probe={probe} />)
    try {
      await letTimersRun({ setup, ms: 150 })
      expect(ticksOf('hideable')).toBeGreaterThanOrEqual(2)

      probe.hide?.()
      await frameSettled({ setup })
      const before = setup.renderer.getStats().frameCount

      await letTimersRun({ setup, ms: 300 })

      expect(setup.renderer.getStats().frameCount - before).toBe(0)
    } finally {
      setup.renderer.destroy()
    }
  })

  it('neither subscribes nor moves while inactive', async () => {
    const setup = await mounted(<Shimmering label="idle" active={false} />)
    try {
      const before = setup.renderer.getStats().frameCount

      await letTimersRun({ setup, ms: 200 })

      expect(setup.renderer.getStats().frameCount - before).toBe(0)
      expect(new Set(seen.get('idle')).size).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })
})
