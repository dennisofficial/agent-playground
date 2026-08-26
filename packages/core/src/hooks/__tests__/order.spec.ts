import { describe, expect, it } from 'bun:test'

import { EStage, orderHooks, type HookOrder } from '../order'

type NamedHook = { name: string; order: HookOrder }

const named = (name: string, stage: EStage, nudge: number): NamedHook => ({ name, order: { stage, nudge } })

const namesOf = (hooks: readonly NamedHook[]): string[] => hooks.map((hook) => hook.name)

describe('orderHooks', () => {
  it('runs guards before policies and policies before observers', () => {
    const ordered = orderHooks([
      named('audit', EStage.Observe, 0),
      named('approvals', EStage.Policy, 0),
      named('boundary', EStage.Guard, 0),
    ])

    expect(namesOf(ordered)).toEqual(['boundary', 'approvals', 'audit'])
  })

  it('runs the lower nudge first within a stage, and never lets it cross a stage', () => {
    const ordered = orderHooks([
      named('late-guard', EStage.Guard, 90),
      named('eager-policy', EStage.Policy, -10),
      named('early-guard', EStage.Guard, 10),
    ])

    expect(namesOf(ordered)).toEqual(['early-guard', 'late-guard', 'eager-policy'])
  })

  it('breaks a shared nudge by name rather than by where the array put them', () => {
    const declared = [named('zebra', EStage.Guard, 50), named('alpha', EStage.Guard, 50)]

    expect(namesOf(orderHooks(declared))).toEqual(['alpha', 'zebra'])
    expect(namesOf(orderHooks([...declared].reverse()))).toEqual(['alpha', 'zebra'])
  })

  it('leaves the list it was handed alone', () => {
    const declared = [named('zebra', EStage.Observe, 0), named('alpha', EStage.Guard, 0)]

    orderHooks(declared)

    expect(namesOf(declared)).toEqual(['zebra', 'alpha'])
  })

  it('orders nothing and one thing', () => {
    expect(orderHooks([])).toEqual([])
    expect(namesOf(orderHooks([named('boundary', EStage.Guard, 0)]))).toEqual(['boundary'])
  })
})
