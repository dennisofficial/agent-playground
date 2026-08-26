import { describe, expect, it } from 'bun:test'

import type { EventDraft } from '@dltech/atlas-core'

import { EToolVerb } from '../../ui/tool-verbs'
import { ECallState, EGroupState, toolGroups } from '../tool-groups'
import { log } from './fixture'
import { called, callId, denied, failed, result, said } from './tool-fixture'

const shapeOf = (drafts: readonly EventDraft[]) =>
  toolGroups(log(drafts)).map((group) => [group.verb.verb, group.totals.count] as const)

describe('grouping by verb and adjacency', () => {
  it('folds a run of adjacent calls sharing a verb into one group', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'read' }),
        result({ n: 1, name: 'read' }),
        called({ n: 2, name: 'read' }),
        result({ n: 2, name: 'read' }),
        called({ n: 3, name: 'read' }),
        result({ n: 3, name: 'read' }),
      ]),
    )

    expect(groups.length).toBe(1)
    expect(groups[0]?.label).toBe('Read 3 files')
    expect(groups[0]?.calls.map((call) => call.callId)).toEqual([callId(1), callId(2), callId(3)])
  })

  it('opens a new group the moment the verb changes', () => {
    expect(
      shapeOf([
        called({ n: 1, name: 'read' }),
        called({ n: 2, name: 'read' }),
        called({ n: 3, name: 'edit' }),
        called({ n: 4, name: 'read' }),
      ]),
    ).toEqual([
      [EToolVerb.Read, 2],
      [EToolVerb.Edit, 1],
      [EToolVerb.Read, 1],
    ])
  })

  it('opens a new group when a sentence lands between two calls of the same verb', () => {
    expect(
      shapeOf([
        called({ n: 1, name: 'read' }),
        result({ n: 1, name: 'read' }),
        said('Now I know where the loop lives.'),
        called({ n: 2, name: 'read' }),
      ]),
    ).toEqual([
      [EToolVerb.Read, 1],
      [EToolVerb.Read, 1],
    ])
  })

  it('lets the results and the reasoning between two calls pass without breaking the run', () => {
    expect(
      shapeOf([
        called({ n: 1, name: 'read' }),
        result({ n: 1, name: 'read' }),
        { type: 'assistant-said', parts: [{ type: 'reasoning', text: 'still looking' }] },
        called({ n: 2, name: 'read' }),
      ]),
    ).toEqual([[EToolVerb.Read, 2]])
  })

  it('breaks the run on a message from the operator and on a nudge', () => {
    expect(
      shapeOf([
        called({ n: 1, name: 'read' }),
        { type: 'user-said', text: 'stop' },
        called({ n: 2, name: 'read' }),
        { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
        called({ n: 3, name: 'read' }),
      ]),
    ).toEqual([
      [EToolVerb.Read, 1],
      [EToolVerb.Read, 1],
      [EToolVerb.Read, 1],
    ])
  })

  it('keeps two differently named unknown tools apart', () => {
    expect(shapeOf([called({ n: 1, name: 'alpha' }), called({ n: 2, name: 'beta' })]).length).toBe(2)
  })
})

describe('what a group says about how it went', () => {
  it('is live while any of its calls is unsettled, and reads in the present tense', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'read' }),
        result({ n: 1, name: 'read' }),
        called({ n: 2, name: 'read' }),
      ]),
    )

    expect(groups[0]?.state).toBe(EGroupState.Live)
    expect(groups[0]?.label).toBe('Reading files')
    expect(groups[0]?.totals).toMatchObject({ count: 2, settled: 1 })
  })

  it('settles to ok when every call came back clean', () => {
    const groups = toolGroups(log([called({ n: 1, name: 'read' }), result({ n: 1, name: 'read' })]))

    expect(groups[0]?.state).toBe(EGroupState.Ok)
    expect(groups[0]?.calls[0]?.state).toBe(ECallState.Ok)
  })

  it('fails as a whole when one of its calls failed, and keeps the message on the call', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'edit' }),
        result({ n: 1, name: 'edit' }),
        called({ n: 2, name: 'edit' }),
        failed({ n: 2, name: 'edit', message: 'no such file' }),
      ]),
    )

    expect(groups[0]?.state).toBe(EGroupState.Failed)
    expect(groups[0]?.calls.map((call) => call.state)).toEqual([ECallState.Ok, ECallState.Failed])
    expect(groups[0]?.calls[1]?.note).toBe('no such file')
  })

  it('counts a denied call as a call that did not succeed, and keeps the reason', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'write' }),
        denied({ n: 1, name: 'write', reason: 'outside workspace' }),
      ]),
    )

    expect(groups[0]?.state).toBe(EGroupState.Failed)
    expect(groups[0]?.calls[0]?.state).toBe(ECallState.Denied)
    expect(groups[0]?.calls[0]?.note).toBe('outside workspace')
  })
})
