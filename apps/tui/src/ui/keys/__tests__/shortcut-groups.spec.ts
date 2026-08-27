import { describe, expect, it } from 'bun:test'

import { EKeyGroup, EKeyLayer, type PlacedBinding } from '../binding'
import { groupsOfBindings } from '../shortcut-groups'

const bound = (over: Partial<PlacedBinding>): PlacedBinding => ({
  chord: 'ctrl+n',
  hint: 'new conversation',
  layer: EKeyLayer.Global,
  group: EKeyGroup.Session,
  placed: 1,
  run: () => undefined,
  ...over,
})

const labelsIn = (args: { title: string; groups: ReturnType<typeof groupsOfBindings> }) =>
  args.groups.find((group) => group.title === args.title)?.shortcuts.map((one) => one.label) ?? []

describe('the shortcuts list the ? overlay shows', () => {
  it('lists a binding under the group it declared, spelled the way it is pressed', () => {
    const groups = groupsOfBindings([bound({})])

    expect(groups.map((group) => group.title)).toEqual([EKeyGroup.Composer, EKeyGroup.Session])
    expect(labelsIn({ title: EKeyGroup.Session, groups })).toEqual(['new conversation'])
  })

  it('prefers the long description over the inline hint, so the list can explain itself', () => {
    const groups = groupsOfBindings([
      bound({ hint: 'send', describe: 'send — or open the newest block' }),
    ])

    expect(labelsIn({ title: EKeyGroup.Session, groups })).toEqual([
      'send — or open the newest block',
    ])
  })

  it('keeps documenting what the composer itself owns rather than only what is bound', () => {
    expect(labelsIn({ title: EKeyGroup.Composer, groups: groupsOfBindings([]) })).toEqual([
      'newline',
    ])
  })

  it('leaves an ungrouped binding out, since a transient key is not a documented one', () => {
    const groups = groupsOfBindings([bound({ group: undefined })])

    expect(labelsIn({ title: EKeyGroup.Session, groups })).toEqual([])
  })

  it('orders the groups the same way every time, whatever order things mounted in', () => {
    const groups = groupsOfBindings([
      bound({ group: EKeyGroup.Turn, chord: 'escape', hint: 'interrupt', placed: 1 }),
      bound({ group: EKeyGroup.Session, placed: 2 }),
    ])

    expect(groups.map((group) => group.title)).toEqual([
      EKeyGroup.Composer,
      EKeyGroup.Session,
      EKeyGroup.Turn,
    ])
  })

  it('shows a chord in its pressed spelling', () => {
    const groups = groupsOfBindings([bound({ group: EKeyGroup.Turn, chord: 'escape' })])
    const turn = groups.find((group) => group.title === EKeyGroup.Turn)

    expect(turn?.shortcuts[0]?.key).toBe('esc')
  })
})
