import { describe, expect, it } from 'bun:test'

import { toEventId } from '../../../events/ids'
import type { Message } from '../../../message/message'
import type { MessagePart } from '../../../message/parts'
import type { ProviderOptions } from '../../../provider'
import type { Assembled, AssembledMessage } from '../../assembled'
import type { RuleContext } from '../../rule'
import { contextFor } from '../../__tests__/log-fixture'
import {
  ANTHROPIC_PROVIDER_ID,
  CACHE_ANCHOR_STRIDE_BLOCKS,
  CACHE_BREAKPOINT_BUDGET,
  CACHE_LOOKBACK_BLOCKS,
  ECacheTtl,
  cacheBreakpoints,
} from '../cache-breakpoints'

const anthropicContext = (): RuleContext => ({
  ...contextFor({ events: [] }),
  provider: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' },
})

const entry = (message: Message, seq: number): AssembledMessage => ({
  message,
  origin: { eventId: toEventId(`event-${seq}`), seq },
})

const said = (text: string, seq: number): AssembledMessage =>
  entry({ role: 'user', content: [{ type: 'text', text }] }, seq)

const answered = (parts: number, seq: number): AssembledMessage =>
  entry(
    {
      role: 'assistant',
      content: Array.from({ length: parts }, (_unused, index) => ({ type: 'text' as const, text: `part ${index}` })),
    },
    seq,
  )

const spoken = (turns: number): AssembledMessage[] =>
  Array.from({ length: turns }, (_unused, index) => said(`turn ${index}`, index + 1))

const apply = ({ assembled, ctx }: { assembled: Assembled; ctx?: RuleContext }): Assembled =>
  cacheBreakpoints()(assembled, [], ctx ?? anthropicContext())

const cacheControlOf = (options: ProviderOptions | undefined): unknown => options?.[ANTHROPIC_PROVIDER_ID]?.cacheControl

const markedBlockPositions = (assembled: Assembled): number[] => {
  const positions: number[] = []
  let blocks = 0
  for (const message of assembled.messages) {
    const parts: readonly MessagePart[] = message.message.content
    for (const part of parts) {
      blocks += 1
      if (cacheControlOf(part.providerOptions) !== undefined) positions.push(blocks)
    }
  }
  return positions
}

const countBreakpoints = (assembled: Assembled): number =>
  assembled.system.filter((block) => cacheControlOf(block.providerOptions) !== undefined).length +
  markedBlockPositions(assembled).length

describe('cacheBreakpoints', () => {
  it('marks only the last system block, so tools and system cache together behind one breakpoint', () => {
    const marked = apply({
      assembled: { system: [{ text: 'preamble' }, { text: 'workspace' }], messages: [] },
    })

    expect(marked.system.map((block) => cacheControlOf(block.providerOptions))).toEqual([
      undefined,
      { type: 'ephemeral', ttl: ECacheTtl.OneHour },
    ])
  })

  it('marks the last message, so the next step reads the whole conversation back', () => {
    const marked = apply({ assembled: { system: [], messages: spoken(3) } })

    expect(markedBlockPositions(marked)).toEqual([3])
  })

  it('gives the conversation the shorter ttl, which must follow the longer-lived system entry', () => {
    const marked = apply({ assembled: { system: [{ text: 'preamble' }], messages: spoken(1) } })

    const tail = marked.messages[0]?.message.content[0]
    expect(cacheControlOf(tail?.providerOptions)).toEqual({ type: 'ephemeral', ttl: ECacheTtl.FiveMinutes })
  })

  it('leaves another provider untouched, because cacheControl is an Anthropic option', () => {
    const assembled: Assembled = { system: [{ text: 'preamble' }], messages: spoken(2) }

    const marked = cacheBreakpoints()(assembled, [], contextFor({ events: [] }))

    expect(marked).toEqual(assembled)
  })

  it('never spends more than the four breakpoints the API allows', () => {
    const marked = apply({
      assembled: { system: [{ text: 'preamble' }], messages: [answered(CACHE_ANCHOR_STRIDE_BLOCKS * 9, 1)] },
    })

    expect(countBreakpoints(marked)).toBeLessThanOrEqual(CACHE_BREAKPOINT_BUDGET)
  })

  it('anchors every stride so a long turn never outruns the lookback window', () => {
    const marked = apply({
      assembled: { system: [], messages: [...spoken(30), answered(25, 31)] },
    })

    const positions = markedBlockPositions(marked)
    const gaps = positions.slice(1).map((position, index) => position - (positions[index] ?? 0))
    expect(gaps.every((gap) => gap <= CACHE_LOOKBACK_BLOCKS)).toBe(true)
  })

  it('anchors at absolute block positions, so an appended turn re-marks the blocks it already marked', () => {
    const before = spoken(30)
    const after = [...before, said('one more', 31)]

    const anchorsBefore = markedBlockPositions(apply({ assembled: { system: [], messages: before } })).slice(0, -1)
    const anchorsAfter = markedBlockPositions(apply({ assembled: { system: [], messages: after } })).slice(0, -1)

    expect(anchorsAfter).toContain(anchorsBefore[anchorsBefore.length - 1] ?? -1)
  })

  it('skips a reasoning part, because a thinking block is not a cacheable position', () => {
    const thought = entry(
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'here it is' },
          { type: 'reasoning', text: 'still thinking' },
        ],
      },
      1,
    )

    const marked = apply({ assembled: { system: [], messages: [thought] } })

    expect(markedBlockPositions(marked)).toEqual([1])
  })

  it('leaves a message with nothing cacheable unmarked rather than marking its thinking', () => {
    const onlyThought = entry({ role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }] }, 1)

    const marked = apply({ assembled: { system: [], messages: [onlyThought] } })

    expect(markedBlockPositions(marked)).toEqual([])
  })

  it('merges with the options a part already carries instead of replacing them', () => {
    const signed = entry(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi', providerOptions: { anthropic: { signature: 'abc' }, openai: { id: '1' } } }],
      },
      1,
    )

    const marked = apply({ assembled: { system: [], messages: [signed] } })

    expect(marked.messages[0]?.message.content[0]?.providerOptions).toEqual({
      anthropic: { signature: 'abc', cacheControl: { type: 'ephemeral', ttl: ECacheTtl.FiveMinutes } },
      openai: { id: '1' },
    })
  })

  it('takes the ttls it was built with, so a running session cannot flip them mid-conversation', () => {
    const annotator = cacheBreakpoints({ systemTtl: ECacheTtl.FiveMinutes, messageTtl: ECacheTtl.OneHour })

    const marked = annotator({ system: [{ text: 'preamble' }], messages: spoken(1) }, [], anthropicContext())

    expect(cacheControlOf(marked.system[0]?.providerOptions)).toEqual({
      type: 'ephemeral',
      ttl: ECacheTtl.FiveMinutes,
    })
    expect(cacheControlOf(marked.messages[0]?.message.content[0]?.providerOptions)).toEqual({
      type: 'ephemeral',
      ttl: ECacheTtl.OneHour,
    })
  })

  it('marks nothing when there is nothing to mark', () => {
    const marked = apply({ assembled: { system: [], messages: [] } })

    expect(marked).toEqual({ system: [], messages: [] })
  })
})
