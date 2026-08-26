import { describe, expect, it } from 'bun:test'

import { EFinishReason, toCallId, type Chunk } from '@dltech/atlas-core'

import { createPartAccumulator } from '../accumulator'

const drive = (chunks: readonly Chunk[]) => {
  const accumulator = createPartAccumulator()
  for (const chunk of chunks) accumulator.handle(chunk)
  return accumulator.finish()
}

describe('createPartAccumulator', () => {
  it('opens on a text start, appends deltas and closes on the end', () => {
    const result = drive([
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', text: 'two ' },
      { type: 'text-delta', id: 't0', text: 'files' },
      { type: 'text-end', id: 't0' },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([{ type: 'text', text: 'two files' }])
    expect(result.finishReason).toBe(EFinishReason.Stop)
  })

  it('opens on a reasoning start and keeps it distinct from text', () => {
    const result = drive([
      { type: 'reasoning-start', id: 'r0' },
      { type: 'reasoning-delta', id: 'r0', text: 'thinking' },
      { type: 'reasoning-end', id: 'r0' },
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', text: 'answer' },
      { type: 'text-end', id: 't0' },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('merges provider metadata from the start chunk, every delta and the end chunk', () => {
    const result = drive([
      { type: 'reasoning-start', id: 'r0', providerMetadata: { anthropic: { fromStart: 'a' } } },
      { type: 'reasoning-delta', id: 'r0', text: 'one ', providerMetadata: { anthropic: { fromDelta: 'b' } } },
      { type: 'reasoning-delta', id: 'r0', text: 'two', providerMetadata: { openai: { fromOtherNamespace: 'c' } } },
      { type: 'reasoning-end', id: 'r0', providerMetadata: { anthropic: { signature: 'sig-abc' } } },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([
      {
        type: 'reasoning',
        text: 'one two',
        providerOptions: {
          anthropic: { fromStart: 'a', fromDelta: 'b', signature: 'sig-abc' },
          openai: { fromOtherNamespace: 'c' },
        },
      },
    ])
  })

  it('keeps a signature that only ever appears on the end chunk', () => {
    const result = drive([
      { type: 'reasoning-start', id: 'r0' },
      { type: 'reasoning-delta', id: 'r0', text: 'thinking' },
      { type: 'reasoning-end', id: 'r0', providerMetadata: { anthropic: { signature: 'sig-abc' } } },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([
      { type: 'reasoning', text: 'thinking', providerOptions: { anthropic: { signature: 'sig-abc' } } },
    ])
  })

  it('closes the blocks still open at the end of the stream, in the order they opened', () => {
    const result = drive([
      { type: 'reasoning-start', id: 'r0' },
      { type: 'reasoning-delta', id: 'r0', text: 'thinking' },
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', text: 'answer' },
      { type: 'finish', reason: EFinishReason.Length },
    ])

    expect(result.parts).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ])
    expect(result.finishReason).toBe(EFinishReason.Length)
  })

  it('collects tool calls', () => {
    const result = drive([
      { type: 'tool-call', callId: toCallId('call-1'), name: 'read_file', input: { path: 'a.ts' } },
      { type: 'finish', reason: EFinishReason.ToolCalls },
    ])

    expect(result.toolCalls).toEqual([{ callId: toCallId('call-1'), name: 'read_file', input: { path: 'a.ts' } }])
    expect(result.finishReason).toBe(EFinishReason.ToolCalls)
  })

  it('ignores deltas for a block that never opened rather than inventing one', () => {
    const result = drive([
      { type: 'text-delta', id: 'ghost', text: 'orphan' },
      { type: 'text-end', id: 'ghost' },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([])
  })

  it('reports Other when the stream never said why it finished', () => {
    expect(drive([{ type: 'text-start', id: 't0' }, { type: 'text-end', id: 't0' }]).finishReason).toBe(
      EFinishReason.Other,
    )
  })

  it('drops a text block the provider opened and closed without saying anything', () => {
    const result = drive([
      { type: 'reasoning-start', id: 'r0' },
      { type: 'reasoning-delta', id: 'r0', text: 'thinking' },
      { type: 'reasoning-end', id: 'r0' },
      { type: 'text-start', id: 't0' },
      { type: 'text-end', id: 't0' },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([{ type: 'reasoning', text: 'thinking' }])
  })

  it('drops a text block holding nothing but whitespace, as Claude sends after thinking', () => {
    const result = drive([
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', text: '  \n ' },
      { type: 'text-end', id: 't0' },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([])
  })

  it('keeps the whitespace inside a text block that says something', () => {
    const result = drive([
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', text: '  two files\n' },
      { type: 'text-end', id: 't0' },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([{ type: 'text', text: '  two files\n' }])
  })

  it('keeps a reply cut off mid-sentence, since a partial reply is not a blank one', () => {
    const result = drive([
      { type: 'text-start', id: 't0' },
      { type: 'text-delta', id: 't0', text: 'two files cha' },
      { type: 'finish', reason: EFinishReason.Length },
    ])

    expect(result.parts).toEqual([{ type: 'text', text: 'two files cha' }])
  })

  it('keeps a reasoning block the provider closed empty, whose signature still has to round-trip', () => {
    const result = drive([
      { type: 'reasoning-start', id: 'r0' },
      { type: 'reasoning-end', id: 'r0', providerMetadata: { anthropic: { signature: 'sig-abc' } } },
      { type: 'finish', reason: EFinishReason.Stop },
    ])

    expect(result.parts).toEqual([
      { type: 'reasoning', text: '', providerOptions: { anthropic: { signature: 'sig-abc' } } },
    ])
  })
})
