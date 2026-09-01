import { describe, expect, it } from 'bun:test'

import type { CompiledPrompt } from '../../prompt/compiled'
import { assemble } from '../assemble'
import { ANTHROPIC_PROVIDER_ID } from '../annotators/cache-breakpoints'
import { defaultPipeline, defaultRules } from '../pipeline'
import { EMPTY_PROMPT } from '../rules/system-prompt'
import { contextFor, log } from './log-fixture'

const PROJECT_DIRECTORY = '/w'

const DOCTRINE = 'You are Atlas, a coding agent talking to a developer in their terminal.'

const compiled = (text: string): CompiledPrompt => ({
  blocks: [{ text }],
  parts: [{ id: 'fixture.doctrine', text, chars: text.length }],
  skipped: [],
})

const anthropic = (events: ReturnType<typeof log>) => ({
  ...contextFor({ events }),
  provider: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' },
})

describe('defaultRules', () => {
  it('assembles a spoken exchange into the compiled prompt plus the turns', () => {
    const events = log([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
      { type: 'user-said', text: 'again' },
    ])

    const { assembled, trace } = assemble({
      rules: defaultRules({ prompt: () => compiled(DOCTRINE), launchDirectory: PROJECT_DIRECTORY }),
      ctx: contextFor({ events }),
    })

    expect(assembled.system).toEqual([{ text: DOCTRINE }])
    expect(assembled.messages.map((entry) => entry.origin.seq)).toEqual([1, 2, 3])
    expect(trace.map((step) => step.name)).toEqual([
      'systemPrompt',
      'messagesFromEvents',
      'agentEndingsBlock',
      'compactedHistory',
      'imagesInContext',
      'worktreeBlock',
    ])
  })

  it('carries whatever the composition root compiled, rather than prose of its own', () => {
    const rules = defaultRules({ prompt: () => compiled('The project directory is /w.'), launchDirectory: PROJECT_DIRECTORY })

    const { assembled } = assemble({ rules, ctx: contextFor({ events: log([]) }) })

    expect(assembled.system).toEqual([{ text: 'The project directory is /w.' }])
  })

  it('sends no system block at all when the registry compiled none', () => {
    const rules = defaultRules({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY })

    const { assembled, trace } = assemble({ rules, ctx: contextFor({ events: log([]) }) })

    expect(assembled.system).toEqual([])
    expect(trace.map((step) => step.name)).toContain('systemPrompt')
  })

  it('re-reads the source each assembly, so a rebuilt prompt reaches the next step', () => {
    let held = compiled('first')
    const rules = defaultRules({ prompt: () => held, launchDirectory: PROJECT_DIRECTORY })
    const ctx = contextFor({ events: log([]) })

    const before = assemble({ rules, ctx }).assembled.system
    held = compiled('second')
    const after = assemble({ rules, ctx }).assembled.system

    expect(before).toEqual([{ text: 'first' }])
    expect(after).toEqual([{ text: 'second' }])
  })

  it('keeps a rule failure skippable rather than fatal, and still emits the prompt', () => {
    const exploding = Object.assign(() => {
      throw new Error('nope')
    }, { ruleName: 'exploding' })

    const { assembled, trace } = assemble({
      rules: [...defaultRules({ prompt: () => compiled(DOCTRINE), launchDirectory: PROJECT_DIRECTORY }), exploding],
      ctx: contextFor({ events: log([{ type: 'user-said', text: 'hello' }]) }),
    })

    expect(assembled.system).toEqual([{ text: DOCTRINE }])
    expect(trace.at(-1)?.name).toBe('exploding')
  })
})

describe('defaultPipeline', () => {
  it('carries the annotators alongside the rules, so one root wires the whole projection', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    const pipeline = defaultPipeline({ prompt: () => compiled(DOCTRINE), launchDirectory: PROJECT_DIRECTORY })

    const { assembled, trace } = assemble({ ...pipeline, ctx: anthropic(events) })

    expect(trace.map((step) => step.name)).toEqual([
      'systemPrompt',
      'messagesFromEvents',
      'agentEndingsBlock',
      'compactedHistory',
      'imagesInContext',
      'worktreeBlock',
      'cacheBreakpoints',
    ])
    expect(assembled.system.at(-1)?.providerOptions).toBeDefined()
    expect(assembled.messages.at(-1)?.message.content.at(-1)?.providerOptions).toBeDefined()
  })

  it('marks nothing on the system side when the registry emitted no block', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    const pipeline = defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY })

    const { assembled } = assemble({ ...pipeline, ctx: anthropic(events) })

    expect(assembled.system).toEqual([])
    expect(assembled.messages.at(-1)?.message.content.at(-1)?.providerOptions).toBeDefined()
  })
})

type PromptIsRequired = undefined extends Parameters<typeof defaultPipeline>[0]['prompt'] ? false : true

type RulesRequireAPrompt = undefined extends Parameters<typeof defaultRules>[0] ? false : true

describe('the argument a composition root cannot forget', () => {
  it('types the compiled prompt as required, so a root that omits it fails to compile', () => {
    const promptIsRequired: PromptIsRequired = true
    const rulesRequireAPrompt: RulesRequireAPrompt = true

    expect([promptIsRequired, rulesRequireAPrompt]).toEqual([true, true])
  })
})
