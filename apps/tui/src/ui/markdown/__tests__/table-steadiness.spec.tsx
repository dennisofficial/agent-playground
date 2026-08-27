import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { MarkdownView } from '../markdown-view'
import { grammarsReady, settle, teardown } from './harness'

await grammarsReady()

const WIDTH = 44

const TABLE = ['| Port | Impls |', '| --- | --- |', '| Clock | 1 |', '| Ids | 2 |'].join('\n')

let push: ((source: string) => void) | null = null

function Streamed(props: { initial: string }): React.ReactNode {
  const [source, setSource] = React.useState(props.initial)
  push = setSource
  return (
    <box flexDirection="column" width={WIDTH} height={16}>
      <MarkdownView source={source} width={WIDTH - 2} streaming />
    </box>
  )
}

async function streamed(source: string, steps: readonly number[]) {
  const setup = await testRender(<Streamed initial={source.slice(0, steps[0])} />, {
    width: WIDTH,
    height: 16,
  })
  await setup.flush()
  await settle()

  for (const stop of steps.slice(1)) {
    await act(async () => void push?.(source.slice(0, stop)))
    await setup.flush()
  }
  await settle()

  return { setup, frame: () => setup.captureCharFrame() }
}

describe('a table held steady while it streams', () => {
  it('draws every row that arrived inside the table, not as prose beneath it', async () => {
    const view = await streamed(TABLE, [20, 26, 34, 40, TABLE.length])
    try {
      const lines = view.frame().split('\n')
      const boxed = lines.filter((line) => line.includes('│'))

      expect(boxed.some((line) => line.includes('Clock'))).toBe(true)
      expect(boxed.some((line) => line.includes('Ids'))).toBe(true)
      expect(lines.some((line) => /^\s*\|/.test(line))).toBe(false)
    } finally {
      await teardown(view.setup)
    }
  }, 60_000)

  it('survives the row where it stops being the block that is still arriving', async () => {
    const source = `${TABLE}\n\ntail prose`
    const view = await streamed(source, [20, 34, TABLE.length, TABLE.length + 6, source.length])
    try {
      const lines = view.frame().split('\n')
      const boxed = lines.filter((line) => line.includes('│'))

      expect(boxed.some((line) => line.includes('Clock'))).toBe(true)
      expect(boxed.some((line) => line.includes('Ids'))).toBe(true)
      expect(lines.some((line) => line.includes('tail prose'))).toBe(true)
      expect(lines.some((line) => /^\s*\|/.test(line))).toBe(false)
    } finally {
      await teardown(view.setup)
    }
  }, 60_000)

  it('holds a table nested inside a quote steady too', async () => {
    const quoted = TABLE.split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    const view = await streamed(quoted, [24, 40, 56, quoted.length])
    try {
      const lines = view.frame().split('\n')
      const boxed = lines.filter((line) => line.includes('\u2502'))

      expect(boxed.some((line) => line.includes('Clock'))).toBe(true)
      expect(boxed.some((line) => line.includes('Ids'))).toBe(true)
    } finally {
      await teardown(view.setup)
    }
  }, 60_000)
})
