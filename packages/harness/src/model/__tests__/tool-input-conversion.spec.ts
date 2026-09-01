import { describe, expect, it } from 'bun:test'
import type { TextStreamPart, ToolSet } from 'ai'

import { toCallId, type Chunk } from '@dltech/atlas-core'

import { createPartAccumulator } from '../accumulator'
import { toCoreChunk } from '../chunk-conversion'

const arriving: TextStreamPart<ToolSet>[] = [
  { type: 'tool-input-start', id: 'call-1', toolName: 'write_file' },
  { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"a.md",' },
  { type: 'tool-input-delta', id: 'call-1', delta: '"content":"hi"}' },
  { type: 'tool-input-end', id: 'call-1' },
  {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'write_file',
    input: { path: 'a.md', content: 'hi' },
  } as TextStreamPart<ToolSet>,
]

describe('a tool call whose arguments arrive a piece at a time', () => {
  it('carries the pieces through as chunks the live view can read', () => {
    expect(arriving.slice(0, 4).map(toCoreChunk)).toEqual([
      { type: 'tool-input-start', callId: toCallId('call-1'), name: 'write_file' },
      { type: 'tool-input-delta', callId: toCallId('call-1'), text: '{"path":"a.md",' },
      { type: 'tool-input-delta', callId: toCallId('call-1'), text: '"content":"hi"}' },
      { type: 'tool-input-end', callId: toCallId('call-1') },
    ])
  })

  it('records the call once, from the assembled input and not from the pieces', () => {
    const accumulator = createPartAccumulator()
    for (const part of arriving) {
      const chunk = toCoreChunk(part)
      if (chunk !== null) accumulator.handle(chunk)
    }

    expect(accumulator.finish().toolCalls).toEqual([
      { callId: toCallId('call-1'), name: 'write_file', input: { path: 'a.md', content: 'hi' } },
    ])
  })

  it('leaves the recorded step untouched when a provider streams no pieces at all', () => {
    const accumulator = createPartAccumulator()
    const only = toCoreChunk(arriving[4] as TextStreamPart<ToolSet>) as Chunk
    accumulator.handle(only)

    expect(accumulator.finish().toolCalls).toEqual([
      { callId: toCallId('call-1'), name: 'write_file', input: { path: 'a.md', content: 'hi' } },
    ])
  })
})
