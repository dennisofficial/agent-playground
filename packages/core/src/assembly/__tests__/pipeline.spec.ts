import { describe, expect, it } from 'bun:test'

import { assemble } from '../assemble'
import { ANTHROPIC_PROVIDER_ID } from '../annotators/cache-breakpoints'
import { defaultPipeline, defaultRules } from '../pipeline'
import { MINIMAL_PREAMBLE } from '../rules/system-preamble'
import { contextFor, log } from './log-fixture'

describe('defaultRules', () => {
  it('assembles a spoken exchange into a preamble plus the turns', () => {
    const events = log([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
      { type: 'user-said', text: 'again' },
    ])

    const { assembled, trace } = assemble({ rules: defaultRules(), ctx: contextFor({ events }) })

    expect(assembled.system).toEqual([{ text: MINIMAL_PREAMBLE }])
    expect(assembled.messages.map((entry) => entry.origin.seq)).toEqual([1, 2, 3])
    expect(trace.map((step) => step.name)).toEqual(['systemPreamble', 'messagesFromEvents'])
  })

  it('threads a workspace through to the preamble the composition root wires', () => {
    const rules = defaultRules({ root: '/w', tools: [] })

    const { assembled } = assemble({ rules, ctx: contextFor({ events: log([]) }) })

    expect(assembled.system[0]?.text).toContain('The workspace root is /w.')
  })
})

describe('defaultPipeline', () => {
  it('carries the annotators alongside the rules, so one root wires the whole projection', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    const pipeline = defaultPipeline({ root: '/w', tools: [] })

    const { assembled, trace } = assemble({
      ...pipeline,
      ctx: { ...contextFor({ events }), provider: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' } },
    })

    expect(trace.map((step) => step.name)).toEqual([
      'systemPreamble',
      'messagesFromEvents',
      'cacheBreakpoints',
    ])
    expect(assembled.system.at(-1)?.providerOptions).toBeDefined()
    expect(assembled.messages.at(-1)?.message.content.at(-1)?.providerOptions).toBeDefined()
  })
})
