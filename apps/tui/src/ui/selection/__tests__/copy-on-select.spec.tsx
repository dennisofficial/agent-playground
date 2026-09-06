import { testRender } from '@opentui/react/test-utils'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import React, { act } from 'react'

const copies: string[] = []

let reachable = true

void mock.module('../../clipboard', () => ({
  copyToClipboard: (args: { text: string }) => {
    copies.push(args.text)
    return reachable
  },
}))

const { NoticeSlab } = await import('../../components/notice-slab')
const { dismissNotice } = await import('../../notice-store')
const { theme } = await import('../../theme')
const { useCopyOnSelect } = await import('../use-copy-on-select')
const { useWordSelect } = await import('../use-word-select')

const WIDTH = 40

const HEIGHT = 6

const FIRST = 'alpha beta gamma'

const SECOND = 'delta epsilon zeta'

function Harness(): React.ReactNode {
  useCopyOnSelect()
  const handleMouse = useWordSelect()

  return (
    <box flexDirection="column" onMouse={handleMouse}>
      <text>{FIRST}</text>
      <text>{SECOND}</text>
      <NoticeSlab bg={theme.appBg} cells={WIDTH} />
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

type Mounted = Awaited<ReturnType<typeof mount>>

async function drag(setup: Mounted, from: [number, number], to: [number, number]): Promise<void> {
  await act(async () => {
    await setup.mockMouse.drag(from[0], from[1], to[0], to[1])
    await setup.flush()
  })
}

async function click(setup: Mounted, at: [number, number]): Promise<void> {
  await act(async () => {
    await setup.mockMouse.click(at[0], at[1])
    await setup.flush()
  })
}

async function doubleClick(setup: Mounted, at: [number, number]): Promise<void> {
  await act(async () => {
    await setup.mockMouse.doubleClick(at[0], at[1])
    await setup.flush()
  })
}

beforeEach(() => {
  copies.length = 0
  reachable = true
  dismissNotice()
})

describe('copy on select', () => {
  it('puts a finished selection on the clipboard and says so on the composer edge', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 0], [10, 0])

      expect(copies).toEqual(['alpha beta'])
      expect(setup.captureCharFrame()).toContain('copied')
    } finally {
      setup.renderer.destroy()
    }
  })

  it('counts the lines when a selection spans more than one', async () => {
    const setup = await mount()
    try {
      await drag(setup, [0, 0], [5, 1])

      expect(copies[0]).toContain('alpha beta gamma')
      expect(setup.captureCharFrame()).toContain('copied 2 lines')
    } finally {
      setup.renderer.destroy()
    }
  })

  it('leaves the clipboard alone on a bare click', async () => {
    const setup = await mount()
    try {
      await click(setup, [2, 0])

      expect(copies).toEqual([])
    } finally {
      setup.renderer.destroy()
    }
  })

  it('reports a clipboard it could not reach rather than claiming success', async () => {
    reachable = false
    const setup = await mount()
    try {
      await drag(setup, [0, 0], [10, 0])

      const frame = setup.captureCharFrame()
      expect(frame).toContain('unavailable')
      expect(frame).not.toContain('copied')
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe('double click', () => {
  it('takes the word under the pointer', async () => {
    const setup = await mount()
    try {
      await doubleClick(setup, [8, 0])

      expect(copies.at(-1)).toBe('beta')
    } finally {
      setup.renderer.destroy()
    }
  })

  it('reaches to whole words when the second click drags', async () => {
    const setup = await mount()
    try {
      await click(setup, [8, 0])
      await act(async () => {
        await setup.mockMouse.pressDown(8, 0)
        await setup.mockMouse.moveTo(8, 1)
        await setup.mockMouse.release(8, 1)
        await setup.flush()
      })

      expect(copies.at(-1)).toBe('beta gamma\ndelta epsilon')
    } finally {
      setup.renderer.destroy()
    }
  })

  it('stays a plain selection when the two clicks land apart', async () => {
    const setup = await mount()
    try {
      await click(setup, [8, 0])
      await drag(setup, [0, 1], [5, 1])

      expect(copies.at(-1)).toBe('delta')
    } finally {
      setup.renderer.destroy()
    }
  })
})
