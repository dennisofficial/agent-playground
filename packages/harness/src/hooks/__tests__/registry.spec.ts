import { describe, expect, it } from 'bun:test'

import { EBeforeToolDecision, EStage, type AfterTool, type BeforeTool } from '@dltech/atlas-core'

import { createHookRegistry, type RegisteredHook } from '../registry'

const allow: BeforeTool = async ({ call }) => ({ decision: EBeforeToolDecision.Allow, input: call.input })

const record: AfterTool = async () => []

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
    })

    expect(registry.beforeTool.map((hook) => hook.name)).toEqual(['first', 'alpha', 'zebra', 'audit'])
    expect(registry.afterTool.map((hook) => hook.name)).toEqual(['sooner', 'later'])
  })

  it('stands up empty for a harness with no hooks at all', () => {
    const registry = createHookRegistry({})

    expect(registry.beforeTool).toEqual([])
    expect(registry.afterTool).toEqual([])
  })
})
