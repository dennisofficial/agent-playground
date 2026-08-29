import { describe, expect, it } from 'bun:test'

import { ESkipReason, type CompiledPrompt } from '../../../prompt/compiled'
import type { SystemBlock } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { EMPTY_PROMPT, systemPrompt } from '../system-prompt'

const DOCTRINE =
  'You are Atlas, a coding agent talking to a developer in their terminal.\n' +
  'Answer directly and concisely, and prefer using a tool over describing what you would do.\n' +
  '\n' +
  'This conversation is compacted when it grows long: the earlier turns are replaced by a summary\n' +
  'and you will not be able to read them again.'

const ctx = contextFor({ events: log([]) })

const promptOf = (blocks: readonly SystemBlock[]): CompiledPrompt => ({
  blocks,
  parts: blocks.map((block, index) => ({
    id: `fixture-${index}`,
    text: block.text,
    chars: block.text.length,
  })),
  skipped: [],
})

const systemOf = (prompt: CompiledPrompt, earlier: readonly SystemBlock[] = []) =>
  systemPrompt({ prompt: () => prompt })({ system: earlier, messages: [] }, ctx).system

describe('what reaches the provider, pinned byte for byte', () => {
  it('is the compiled text with every newline and blank line exactly as compiled', () => {
    expect(systemOf(promptOf([{ text: DOCTRINE }]))).toEqual([{ text: DOCTRINE }])
  })

  it('applies no trimming, wrapping, prefix or suffix of its own', () => {
    const ragged = '  leading and trailing space  \n\n'

    expect(systemOf(promptOf([{ text: ragged }]))[0]?.text).toBe(ragged)
  })

  it('carries a block holding text and nothing else when the compile gave nothing else', () => {
    expect(Object.keys(systemOf(promptOf([{ text: DOCTRINE }]))[0] ?? {})).toEqual(['text'])
  })

  it('keeps the providerOptions the compile put on a block', () => {
    const marked: SystemBlock = {
      text: DOCTRINE,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    }

    expect(systemOf(promptOf([marked]))).toEqual([marked])
  })
})

describe('how many blocks the rule emits', () => {
  it('emits one system block per compiled block, in compiled order, unjoined', () => {
    expect(systemOf(promptOf([{ text: 'first' }, { text: 'second' }]))).toEqual([
      { text: 'first' },
      { text: 'second' },
    ])
  })

  it('emits none when the compile produced none', () => {
    expect(systemOf(EMPTY_PROMPT)).toEqual([])
  })

  it('emits none when every fragment was skipped, and does not speak for them', () => {
    const allSkipped: CompiledPrompt = {
      blocks: [],
      parts: [],
      skipped: [{ id: 'environment.workspace-root', reason: ESkipReason.Condition }],
    }

    expect(systemOf(allSkipped)).toEqual([])
  })
})

describe('what the rule does to the assembly it was handed', () => {
  it('appends after the blocks already there and leaves them untouched', () => {
    expect(systemOf(promptOf([{ text: DOCTRINE }]), [{ text: 'earlier' }])).toEqual([
      { text: 'earlier' },
      { text: DOCTRINE },
    ])
  })

  it('names itself so the trace can attribute the block', () => {
    expect(systemPrompt({ prompt: () => EMPTY_PROMPT }).ruleName).toBe('systemPrompt')
  })
})
