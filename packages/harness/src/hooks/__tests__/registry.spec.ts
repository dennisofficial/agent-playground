import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EStage,
  type AfterTool,
  type AfterTurn,
  type BeforeRequest,
  type BeforeStep,
  type BeforeTool,
  type OnChunk,
} from '@dltech/atlas-core'

import { createHookRegistry, type RegisteredHook } from '../registry'

const allow: BeforeTool = async ({ call }) => ({ decision: EBeforeToolDecision.Allow, input: call.input })

const record: AfterTool = async () => []

const passStep: BeforeStep = async (assembled) => assembled

const passPrompt: BeforeRequest = async (prompt) => prompt

const passChunk: OnChunk = async (chunk) => chunk

const closeTurn: AfterTurn = async () => []

const guard = (name: string, nudge: number): RegisteredHook<BeforeTool> => ({
  name,
  order: { stage: EStage.Guard, nudge },
  run: allow,
})

describe('createHookRegistry', () => {
  it('orders each phase once, at construction', () => {
    const registry = createHookRegistry({
      beforeTool: [
        { name: 'audit', order: { stage: EStage.Observe, nudge: 0 }, run: allow },
        guard('zebra', 50),
        guard('alpha', 50),
        guard('first', 10),
      ],
      afterTool: [
        { name: 'later', order: { stage: EStage.Observe, nudge: 20 }, run: record },
        { name: 'sooner', order: { stage: EStage.Observe, nudge: 10 }, run: record },
      ],
      beforeStep: [
        { name: 'budget', order: { stage: EStage.Policy, nudge: 0 }, run: passStep },
        { name: 'redact', order: { stage: EStage.Guard, nudge: 0 }, run: passStep },
      ],
      beforeRequest: [
        { name: 'cache-breakpoints', order: { stage: EStage.Observe, nudge: 0 }, run: passPrompt },
        { name: 'strip-internal-ids', order: { stage: EStage.Guard, nudge: 0 }, run: passPrompt },
      ],
      onChunk: [
        { name: 'transcript-log', order: { stage: EStage.Observe, nudge: 0 }, run: passChunk },
        { name: 'secret-redaction', order: { stage: EStage.Guard, nudge: 0 }, run: passChunk },
      ],
      afterTurn: [
        { name: 'zebra', order: { stage: EStage.Observe, nudge: 5 }, run: closeTurn },
        { name: 'alpha', order: { stage: EStage.Observe, nudge: 5 }, run: closeTurn },
      ],
    })

    expect(registry.beforeTool.map((hook) => hook.name)).toEqual(['first', 'alpha', 'zebra', 'audit'])
    expect(registry.afterTool.map((hook) => hook.name)).toEqual(['sooner', 'later'])
    expect(registry.beforeStep.map((hook) => hook.name)).toEqual(['redact', 'budget'])
    expect(registry.beforeRequest.map((hook) => hook.name)).toEqual(['strip-internal-ids', 'cache-breakpoints'])
    expect(registry.onChunk.map((hook) => hook.name)).toEqual(['secret-redaction', 'transcript-log'])
    expect(registry.afterTurn.map((hook) => hook.name)).toEqual(['alpha', 'zebra'])
  })

  it('stands up empty for a harness with no hooks at all', () => {
    const registry = createHookRegistry({})

    expect(registry.beforeTool).toEqual([])
    expect(registry.afterTool).toEqual([])
    expect(registry.beforeStep).toEqual([])
    expect(registry.beforeRequest).toEqual([])
    expect(registry.onChunk).toEqual([])
    expect(registry.afterTurn).toEqual([])
  })
})
