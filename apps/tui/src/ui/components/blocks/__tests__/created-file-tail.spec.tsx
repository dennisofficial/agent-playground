import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { toCallId } from '@dltech/atlas-core'

import { ECallState, type ToolCall } from '../../../../store'
import { teardown } from '../../../markdown/__tests__/harness'
import { ToolCreatedFile } from '../tool-created-file'

const CWD = '/repo'

let ordinal = 0

const writeCall = (args: { lines: number; state: ECallState }): ToolCall => {
  ordinal += 1
  const content = Array.from(
    { length: args.lines },
    (_unused, index) => `const row${String(index + 1).padStart(2, '0')} = ${index + 1}`,
  ).join('\n')
  const settledCall = args.state !== ECallState.Pending
  return {
    callId: toCallId(`created-tail-${ordinal}`),
    name: 'write',
    input: { path: `${CWD}/src/fresh-${ordinal}.ts`, content },
    output: settledCall
      ? { path: `${CWD}/src/fresh-${ordinal}.ts`, created: true, bytes: content.length }
      : undefined,
    modelText: '',
    state: args.state,
    note: null,
    at: null,
    settledAt: settledCall ? '2026-09-06T00:00:00.000Z' : null,
    attachments: [],
  }
}

async function frameOf(call: ToolCall): Promise<string> {
  const setup = await testRender(<ToolCreatedFile call={call} inner={74} cwd={CWD} />, {
    width: 80,
    height: 32,
  })
  try {
    for (let hop = 0; hop < 4000; hop += 1) {
      const frame = setup.captureCharFrame()
      if (frame.includes('row01') || frame.includes('row30')) return frame
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('the panel never drew any file content')
  } finally {
    await teardown(setup)
  }
}

describe('a file still being written shows its tail', () => {
  it('draws the lines being dictated, not the head, past the cap', async () => {
    const frame = await frameOf(writeCall({ lines: 30, state: ECallState.Pending }))
    expect(frame).toContain('row30')
    expect(frame).not.toContain('row01')
  })

  it('numbers the tail rows by their place in the file', async () => {
    const frame = await frameOf(writeCall({ lines: 30, state: ECallState.Pending }))
    expect(frame).toMatch(/30 +const row30/)
    expect(frame).toMatch(/11 +const row11/)
  })

  it('offers no "more" row while the file is still arriving', async () => {
    const frame = await frameOf(writeCall({ lines: 30, state: ECallState.Pending }))
    expect(frame).not.toContain('more')
  })

  it('shows the head of a short file, there being no tail yet', async () => {
    const frame = await frameOf(writeCall({ lines: 5, state: ECallState.Pending }))
    expect(frame).toContain('row01')
    expect(frame).toContain('row05')
  })
})

describe('a settled file keeps the head view', () => {
  it('draws the head and the "more" row', async () => {
    const frame = await frameOf(writeCall({ lines: 30, state: ECallState.Ok }))
    expect(frame).toContain('row01')
    expect(frame).not.toContain('row30')
    expect(frame).toContain('+10 more')
  })
})
