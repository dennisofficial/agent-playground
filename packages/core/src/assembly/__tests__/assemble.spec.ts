import { describe, expect, it } from 'bun:test'

import { assemble } from '../assemble'
import { defaultRules } from '../pipeline'
import { defineAnnotator, defineRule } from '../rule'
import { messagesFromEvents } from '../rules/messages-from-events'
import { MINIMAL_PREAMBLE, systemPreamble } from '../rules/system-preamble'
import { EAssemblyStage, ERuleFailurePolicy } from '../trace'
import { contextFor, log } from './log-fixture'

const exchange = log([
  { type: 'user-said', text: 'hello' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
])

describe('assemble', () => {
  it('returns the prompt and a trace with one step per rule, in order', () => {
    const { assembled, trace } = assemble({
      rules: [systemPreamble(), messagesFromEvents()],
      ctx: contextFor({ events: exchange }),
    })

    expect(assembled.system.map((block) => block.text)).toEqual([MINIMAL_PREAMBLE])
    expect(assembled.messages.map((entry) => entry.message.role)).toEqual(['user', 'assistant'])
    expect(trace.map((step) => [step.stage, step.name, step.systemBlocks, step.messages])).toEqual([
      [EAssemblyStage.Rule, 'systemPreamble', 1, 0],
      [EAssemblyStage.Rule, 'messagesFromEvents', 1, 2],
    ])
  })

  it('starts from an empty prompt, so no rules means nothing assembled', () => {
    const { assembled, trace } = assemble({ rules: [], ctx: contextFor({ events: exchange }) })

    expect(assembled).toEqual({ system: [], messages: [] })
    expect(trace).toEqual([])
  })

  it('records the token count each rule left behind', () => {
    const { trace } = assemble({
      rules: [defineRule({ name: 'fourChars', apply: () => ({ system: [{ text: 'abcd' }], messages: [] }) })],
      ctx: contextFor({ events: [] }),
    })

    expect(trace[0]?.tokens).toBe(1)
  })

  it('lets a throwing rule pass its input through and records the failure on the trace', () => {
    const exploding = defineRule({
      name: 'exploding',
      apply: () => {
        throw new Error('rule blew up')
      },
    })

    const { assembled, trace } = assemble({
      rules: [messagesFromEvents(), exploding, systemPreamble()],
      ctx: contextFor({ events: exchange }),
    })

    expect(assembled.messages).toHaveLength(2)
    expect(assembled.system.map((block) => block.text)).toEqual([MINIMAL_PREAMBLE])
    expect(trace.map((step) => [step.name, step.failure])).toEqual([
      ['messagesFromEvents', undefined],
      ['exploding', 'rule blew up'],
      ['systemPreamble', undefined],
    ])
  })

  it('drops the whole conversation when the last rule is the one that throws', () => {
    const exploding = defineRule({
      name: 'explodingMessages',
      apply: () => {
        throw new Error('output was not renderable')
      },
    })

    const { assembled, trace } = assemble({
      rules: [systemPreamble(), exploding],
      ctx: contextFor({ events: exchange }),
    })

    expect(defaultRules().at(-1)?.ruleName).toBe('compactedHistory')
    expect(assembled.system.map((block) => block.text)).toEqual([MINIMAL_PREAMBLE])
    expect(assembled.messages).toEqual([])
    expect(trace.at(-1)).toMatchObject({
      name: 'explodingMessages',
      messages: 0,
      failure: 'output was not renderable',
    })
  })

  it('rethrows under the throwing failure policy', () => {
    const exploding = defineRule({
      name: 'exploding',
      apply: () => {
        throw new Error('rule blew up')
      },
    })

    expect(() =>
      assemble({
        rules: [exploding],
        ctx: contextFor({ events: exchange }),
        onRuleFailure: ERuleFailurePolicy.Throw,
      }),
    ).toThrow('rule blew up')
  })

  it('runs annotators after every rule, with the rule trace to read', () => {
    const namesSeen: string[][] = []
    const stamping = defineAnnotator({
      name: 'stampRulesThatRan',
      apply: (input, trace) => {
        namesSeen.push(trace.map((step) => step.name))
        return { system: [...input.system, { text: trace.map((step) => step.name).join(',') }], messages: input.messages }
      },
    })

    const { assembled, trace } = assemble({
      rules: [systemPreamble(), messagesFromEvents()],
      annotators: [stamping],
      ctx: contextFor({ events: exchange }),
    })

    expect(namesSeen).toEqual([['systemPreamble', 'messagesFromEvents']])
    expect(assembled.system.at(-1)?.text).toBe('systemPreamble,messagesFromEvents')
    expect(trace.map((step) => [step.stage, step.name])).toEqual([
      [EAssemblyStage.Rule, 'systemPreamble'],
      [EAssemblyStage.Rule, 'messagesFromEvents'],
      [EAssemblyStage.Annotator, 'stampRulesThatRan'],
    ])
  })

  it('lets a throwing annotator pass its input through too', () => {
    const exploding = defineAnnotator({
      name: 'explodingAnnotator',
      apply: () => {
        throw new Error('annotator blew up')
      },
    })

    const { assembled, trace } = assemble({
      rules: [messagesFromEvents()],
      annotators: [exploding],
      ctx: contextFor({ events: exchange }),
    })

    expect(assembled.messages).toHaveLength(2)
    expect(trace.at(-1)).toMatchObject({ name: 'explodingAnnotator', failure: 'annotator blew up' })
  })

  it('assembles the same log twice into equal results', () => {
    const run = () =>
      assemble({
        rules: [systemPreamble(), messagesFromEvents()],
        ctx: contextFor({ events: exchange }),
      })

    const first = run()
    const second = run()

    expect(second.assembled).toEqual(first.assembled)
    expect(second.trace).toEqual(first.trace)
  })

  it('leaves the event log it read untouched', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    const snapshot = structuredClone(events)

    assemble({ rules: [systemPreamble(), messagesFromEvents()], ctx: contextFor({ events }) })

    expect(events).toEqual(snapshot)
  })
})
