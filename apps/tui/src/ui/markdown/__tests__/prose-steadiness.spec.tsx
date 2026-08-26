import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { MarkdownView } from '../markdown-view'
import { grammarsReady, settle, teardown } from './harness'

await grammarsReady()

const WIDTH = 44

let push: ((source: string) => void) | null = null

function Streamed(props: { initial: string }): React.ReactNode {
  const [source, setSource] = React.useState(props.initial)
  push = setSource
  return (
    <box flexDirection="column" width={WIDTH} height={12}>
      <MarkdownView source={source} width={WIDTH - 2} streaming />
    </box>
  )
}

async function mounted(initial: string) {
  const setup = await testRender(<Streamed initial={initial} />, { width: WIDTH, height: 12 })
  await setup.flush()
  await settle()

  const frame = () => setup.captureCharFrame()

  return {
    setup,
    frame,
    async grow(source: string) {
      await act(async () => void push?.(source))
      await setup.flush()
      return frame()
    },
  }
}

describe('prose held steady while it streams', () => {
  it('never paints a heading’s raw markers between deltas', async () => {
    const view = await mounted('## Header')
    try {
      expect(view.frame()).not.toContain('##')

      for (const source of ['## Header o', '## Header on', '## Header one']) {
        expect(await view.grow(source)).not.toContain('##')
      }
    } finally {
      await teardown(view.setup)
    }
  }, 60_000)

  it('keeps the last styled text up rather than blanking while the next highlight lands', async () => {
    const view = await mounted('## Header')
    try {
      expect(await view.grow('## Header one')).toContain('Header')
    } finally {
      await teardown(view.setup)
    }
  }, 60_000)

  it('never paints raw emphasis markers either', async () => {
    const view = await mounted('a **bold** word')
    try {
      expect(await view.grow('a **bold** word and')).not.toContain('**')
      await settle()
      expect(view.frame()).not.toContain('**')
    } finally {
      await teardown(view.setup)
    }
  }, 60_000)
})
