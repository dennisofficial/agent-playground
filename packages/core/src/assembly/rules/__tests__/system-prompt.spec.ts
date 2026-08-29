import { describe, expect, it } from 'bun:test'

import { ESkipReason, type CompiledPrompt } from '../../../prompt/compiled'
import type { Assembled } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { EMPTY_PROMPT, systemPrompt } from '../system-prompt'

const ctx = contextFor({ events: log([]) })

const compiled = (...texts: readonly string[]): CompiledPrompt => ({
  blocks: texts.length === 0 ? [] : [{ text: texts.join('\n\n') }],
  parts: texts.map((text, index) => ({ id: `fixture-${index}`, text, chars: text.length })),
  skipped: [],
})

const fixed = (prompt: CompiledPrompt) => systemPrompt({ prompt: () => prompt })

describe('systemPrompt', () => {
  it('pushes the compiled blocks onto the system it was handed', () => {
    const assembled = fixed(compiled('doctrine'))({ system: [], messages: [] }, ctx)

    expect(assembled.system).toEqual([{ text: 'doctrine' }])
  })

  it('appends after the blocks already there and leaves them untouched', () => {
    const assembled = fixed(compiled('doctrine'))({ system: [{ text: 'earlier' }], messages: [] }, ctx)

    expect(assembled.system).toEqual([{ text: 'earlier' }, { text: 'doctrine' }])
  })

  it('leaves the messages exactly as they arrived', () => {
    const input: Assembled = {
      system: [],
      messages: [
        {
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          origin: { eventId: log([{ type: 'user-said', text: 'hello' }])[0]!.id, seq: 1 },
        },
      ],
    }

    expect(fixed(compiled('doctrine'))(input, ctx).messages).toEqual(input.messages)
  })

  it('emits no block at all when the registry compiled nothing', () => {
    expect(fixed(EMPTY_PROMPT)({ system: [], messages: [] }, ctx).system).toEqual([])
  })

  it('emits nothing when every fragment was skipped, rather than an empty block', () => {
    const nothingApplied: CompiledPrompt = {
      blocks: [],
      parts: [],
      skipped: [{ id: 'capabilities.thinking-budget', reason: ESkipReason.Condition }],
    }

    expect(fixed(nothingApplied)({ system: [], messages: [] }, ctx).system).toEqual([])
  })

  it('names itself so the trace can attribute the block', () => {
    expect(fixed(EMPTY_PROMPT).ruleName).toBe('systemPrompt')
  })
})

describe('what the rule compiles, and what it only reads', () => {
  it('compiles nothing itself — it reads whatever the source hands back', () => {
    let compiles = 0
    const rule = systemPrompt({
      prompt: () => {
        compiles += 1
        return compiled('doctrine')
      }
    })

    rule({ system: [], messages: [] }, ctx)
    rule({ system: [], messages: [] }, ctx)

    expect(compiles).toBe(2)
  })

  it('reads the source at apply time, so a model switch reaches the very next step', () => {
    let held = compiled('doctrine for opus')
    const rule = systemPrompt({ prompt: () => held })

    const before = rule({ system: [], messages: [] }, ctx).system

    held = compiled('doctrine for haiku')

    expect(before).toEqual([{ text: 'doctrine for opus' }])
    expect(rule({ system: [], messages: [] }, ctx).system).toEqual([{ text: 'doctrine for haiku' }])
  })

  it('cannot vary with the conversation, because nothing about it reaches the source', () => {
    const seen: unknown[] = []
    const rule = systemPrompt({
      prompt: (...args) => {
        seen.push(args)
        return compiled('doctrine')
      },
    })

    rule({ system: [], messages: [] }, contextFor({ events: log([{ type: 'user-said', text: 'hi' }]) }))

    expect(seen).toEqual([[]])
  })
})
