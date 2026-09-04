import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { CrashBoundary } from '../crash-boundary'

const SETTLE_MS = 60

function Boom(): React.ReactNode {
  throw new Error('the transcript ate itself')
}

async function mounted(node: React.ReactNode): Promise<{
  frame: () => string
  done: () => Promise<void>
}> {
  const setup = await testRender(node, { width: 80, height: 24 })
  await setup.flush()
  await settle(SETTLE_MS)
  await setup.flush()

  return { frame: () => setup.captureCharFrame(), done: () => teardown(setup) }
}

describe('CrashBoundary', () => {
  it('is transparent while nothing throws', async () => {
    const { frame, done } = await mounted(
      <CrashBoundary>
        <text>all is well</text>
      </CrashBoundary>,
    )

    try {
      expect(frame()).toContain('all is well')
    } finally {
      await done()
    }
  })

  it('answers a throw with the crash screen, the error in it and a way out', async () => {
    const { frame, done } = await mounted(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>,
    )

    try {
      const shown = frame()
      expect(shown).toContain('something broke')
      expect(shown).toContain('the transcript ate itself')
      expect(shown).toContain('copy error')
      expect(shown).toContain('q quit')
    } finally {
      await done()
    }
  })
})
