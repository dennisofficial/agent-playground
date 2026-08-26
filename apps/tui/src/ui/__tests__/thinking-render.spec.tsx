import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../markdown/__tests__/harness'
import { ThinkingBlock } from '../components/blocks/thinking-block'
import { theme } from '../theme'

await grammarsReady()

const WIDTH = 60

const HEIGHT = 12

const THOUGHT = 'Weighed a jti denylist against a per-user token version.\n\nThe denylist wins.'

const hexOf = (colour: { r: number; g: number; b: number }): string =>
  [colour.r, colour.g, colour.b]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
    .join('')

async function groundsUnder(flags: {
  streaming?: boolean
  expanded?: boolean
}): Promise<Set<string>> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT} backgroundColor={theme.appBg}>
      <ThinkingBlock
        text={THOUGHT}
        width={WIDTH}
        onToggle={() => {}}
        {...(flags.streaming ? { streaming: true } : {})}
        {...(flags.expanded ? { expanded: true } : {})}
      />
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    await setup.flush()
    await settle(250)
    await setup.flush()

    return new Set(
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans.map((span) => hexOf(span.bg))),
    )
  } finally {
    await teardown(setup)
  }
}

describe('a thinking block', () => {
  const ground = hexOf(parseColor(theme.appBg))

  it('rests on the app ground, with no band of its own', async () => {
    expect([...(await groundsUnder({}))]).toEqual([ground])
  })

  it('keeps the ground once it is opened', async () => {
    expect([...(await groundsUnder({ expanded: true }))]).toEqual([ground])
  })

  it('keeps the ground while it streams', async () => {
    expect([...(await groundsUnder({ streaming: true }))]).toEqual([ground])
  })
})
