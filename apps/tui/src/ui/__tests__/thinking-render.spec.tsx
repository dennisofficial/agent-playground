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

type Flags = { streaming?: boolean; heldOpen?: boolean; expanded?: boolean }

async function drawn<T>(args: {
  flags: Flags
  read: (setup: Awaited<ReturnType<typeof testRender>>) => T
}): Promise<T> {
  const { flags } = args
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT} backgroundColor={theme.appBg}>
      <ThinkingBlock
        text={THOUGHT}
        width={WIDTH}
        onToggle={() => {}}
        {...(flags.streaming ? { streaming: true } : {})}
        {...(flags.heldOpen ? { heldOpen: true } : {})}
        {...(flags.expanded ? { expanded: true } : {})}
      />
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    await setup.flush()
    await settle(250)
    await setup.flush()

    return args.read(setup)
  } finally {
    await teardown(setup)
  }
}

const groundsUnder = (flags: Flags): Promise<Set<string>> =>
  drawn({
    flags,
    read: (setup) =>
      new Set(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans.map((span) => hexOf(span.bg))),
      ),
  })

const frameOf = (flags: Flags): Promise<string> =>
  drawn({ flags, read: (setup) => setup.captureCharFrame() })

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

  it('keeps the ground while it is held open', async () => {
    expect([...(await groundsUnder({ heldOpen: true }))]).toEqual([ground])
  })

  it('shows its tail while it is held open, not the row it settles into', async () => {
    expect(await frameOf({ heldOpen: true })).toContain('The denylist wins.')
    expect(await frameOf({})).not.toContain('The denylist wins.')
  })
})
