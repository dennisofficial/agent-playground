import { testRender } from '@opentui/react/test-utils'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import React, { act } from 'react'

const copies: string[] = []

void mock.module('../../clipboard', () => ({
  copyToClipboard: (args: { text: string }) => {
    copies.push(args.text)
    return true
  },
}))

const { grammarsReady, teardown } = await import('../../markdown/__tests__/harness')
const { MarkdownView } = await import('../../markdown/markdown-view')
const { useCopyOnSelect } = await import('../use-copy-on-select')

await grammarsReady()

const WIDTH = 44

const HEIGHT = 16

const SOURCE = [
  'A **bold** claim about `assemble`.',
  '',
  '- first point',
  '- second point',
  '',
  'The [docs](https://example.com/spec) say so.',
].join('\n')

function Harness(): React.ReactNode {
  useCopyOnSelect()
  return (
    <box flexDirection="column">
      <MarkdownView source={SOURCE} width={WIDTH} />
    </box>
  )
}

async function mount() {
  const setup = await testRender(<Harness />, { width: WIDTH, height: HEIGHT })
  await act(async () => {
    await setup.flush()
  })
  return setup
}

async function drag(
  setup: Awaited<ReturnType<typeof mount>>,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  await act(async () => {
    await setup.mockMouse.drag(from[0], from[1], to[0], to[1])
    await setup.flush()
  })
}

beforeEach(() => {
  copies.length = 0
})

describe('copying rendered markdown', () => {
  it('hands back the source of every block the selection covers whole', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 0], [WIDTH - 1, 6])

      const copied = copies.at(-1) ?? ''
      expect(copied).toContain('**bold**')
      expect(copied).toContain('`assemble`')
      expect(copied).toContain('- first point')
      expect(copied).toContain('- second point')
      expect(copied).not.toContain('•')
    } finally {
      await teardown(setup)
    }
  })

  it('keeps a link as a link rather than the host it was drawn as', async () => {
    const setup = await mount()
    try {
      const frame = setup.captureCharFrame().split('\n')
      const row = frame.findIndex((line) => line.includes('docs'))
      await drag(setup, [0, row], [WIDTH - 1, row])

      expect(copies.at(-1)).toContain('[docs](https://example.com/spec)')
    } finally {
      await teardown(setup)
    }
  })

  it('falls back to what is on screen when a block is only half covered', async () => {
    const setup = await mount()
    try {
      await drag(setup, [2, 0], [10, 0])

      const copied = copies.at(-1) ?? ''
      expect(copied).not.toContain('**')
      expect(copied.length).toBeGreaterThan(0)
    } finally {
      await teardown(setup)
    }
  })
})
