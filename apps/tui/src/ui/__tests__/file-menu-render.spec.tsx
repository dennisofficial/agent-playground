import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import type { DirectoryEntry } from '@dltech/atlas-core'

import { FileMenu } from '../components/file-menu'
import type { FileMenuState } from '../file-menu-model'
import { grammarsReady, teardown } from '../markdown/__tests__/harness'
import { theme } from '../theme'
import { drawn, HEIGHT } from './transcript-fixture'

await grammarsReady()

const WIDTH = 60

const file = (name: string): DirectoryEntry => ({ name, isDirectory: false })

const LEVEL: readonly DirectoryEntry[] = [file('app.tsx'), file('architecture.md'), file('one.ts')]

const menu = (args: {
  directory?: string
  matches?: readonly DirectoryEntry[]
  index?: number
}): FileMenuState => ({
  index: args.index ?? 0,
  directory: args.directory ?? 'apps/tui/src/composition/',
  fragment: '',
  matches: args.matches ?? LEVEL,
})

type Colour = { equals: (other: unknown) => boolean }

type CapturedSpan = { text: string; fg: Colour }

type CapturedSpans = { lines: ({ spans: CapturedSpan[] } | undefined)[] }

async function shown(state: FileMenuState): Promise<{ frame: string; spans: CapturedSpans }> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <FileMenu state={state} width={WIDTH} />
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    return { frame: await drawn(setup), spans: setup.captureSpans() as CapturedSpans }
  } finally {
    await teardown(setup)
  }
}

const spanFor = ({ spans, text }: { spans: CapturedSpans; text: string }): CapturedSpan | null => {
  for (const line of spans.lines) {
    for (const span of line?.spans ?? []) {
      if (span.text === text) return span
    }
  }
  return null
}

describe('the file menu', () => {
  it('reads the path in one piece, left to right', async () => {
    const { frame } = await shown(menu({}))
    expect(frame).toContain('apps/tui/src/composition/app.tsx')
  })

  it('dims the folders and leaves the file name lit', async () => {
    const { spans } = await shown(menu({}))

    expect(
      spanFor({ spans, text: 'apps/tui/src/composition/' })?.fg.equals(parseColor(theme.hint)),
    ).toBe(true)
    expect(spanFor({ spans, text: 'app.tsx' })?.fg.equals(parseColor(theme.hint))).toBe(false)
  })

  it('brightens the name of the row under the caret', async () => {
    const { spans } = await shown(menu({ index: 1 }))

    expect(spanFor({ spans, text: 'architecture.md' })?.fg.equals(parseColor(theme.bright))).toBe(
      true,
    )
    expect(spanFor({ spans, text: 'app.tsx' })?.fg.equals(parseColor(theme.bright))).toBe(false)
  })

  it('offers to open a directory and to attach a file', async () => {
    const stepping = await shown(
      menu({ directory: 'apps/', matches: [{ name: 'tui', isDirectory: true }] }),
    )
    expect(stepping.frame).toContain('⇥ open')

    const settling = await shown(menu({}))
    expect(settling.frame).toContain('⇥ attach')
  })

  it('closes a directory row with a slash', async () => {
    const { frame } = await shown(
      menu({ directory: 'apps/', matches: [{ name: 'tui', isDirectory: true }] }),
    )
    expect(frame).toContain('apps/tui/')
  })

  it('spends the outer folders first when a path outgrows the row', async () => {
    const { frame } = await shown(
      menu({
        directory: 'packages/harness/src/tools/builtin/__tests__/',
        matches: [file('containment.spec.ts')],
      }),
    )

    const row = frame.split('\n').find((one) => one.includes('containment.spec.ts'))
    expect(row).toContain('__tests__/containment.spec.ts')
    expect(row).toContain('p/h/')
    expect(row).not.toContain('packages/')
  })

  it('shows a file at the starting directory as just its name', async () => {
    const { frame } = await shown(menu({ directory: '', matches: [file('CLAUDE.md')] }))
    expect(frame).toContain('CLAUDE.md')
  })
})
