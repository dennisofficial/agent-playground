import { describe, expect, it } from 'bun:test'

import { stabilisedEntries } from '../stable-entries'
import { EAuthor, EEntryKind, type TranscriptEntry } from '../transcript-model'

const said = (args: { key: string; text: string }): TranscriptEntry => ({
  kind: EEntryKind.OperatorSaid,
  author: EAuthor.Operator,
  key: args.key,
  text: args.text,
  said: [args.text],
  steer: false,
  skills: [],
  files: [],
  images: [],
})

describe('stabilisedEntries', () => {
  it('hands back the previous array when nothing changed', () => {
    const previous = [said({ key: 'a', text: 'one' }), said({ key: 'b', text: 'two' })]
    const next = [said({ key: 'a', text: 'one' }), said({ key: 'b', text: 'two' })]

    expect(stabilisedEntries({ previous, next })).toBe(previous)
  })

  it('keeps the identity of every entry a fresh derive rebuilt unchanged', () => {
    const previous = [said({ key: 'a', text: 'one' })]
    const next = [said({ key: 'a', text: 'one' }), said({ key: 'b', text: 'two' })]

    const settled = stabilisedEntries({ previous, next })

    expect(settled[0]).toBe(previous[0])
    expect(settled[1]).toBe(next[1])
  })

  it('takes the new entry when its content moved', () => {
    const previous = [said({ key: 'a', text: 'one' })]
    const next = [said({ key: 'a', text: 'one, corrected' })]

    const settled = stabilisedEntries({ previous, next })

    expect(settled[0]).toBe(next[0])
    expect(settled).not.toBe(previous)
  })

  it('notices a change nested inside an array of the entry', () => {
    const previous = [{ ...said({ key: 'a', text: 'one' }), skills: ['tdd'] }]
    const next = [{ ...said({ key: 'a', text: 'one' }), skills: ['tdd', 'research'] }]

    expect(stabilisedEntries({ previous, next })[0]).toBe(next[0])
  })

  it('drops what is no longer derived rather than holding it alive', () => {
    const previous = [said({ key: 'a', text: 'one' }), said({ key: 'b', text: 'two' })]
    const next = [said({ key: 'b', text: 'two' })]

    const settled = stabilisedEntries({ previous, next })

    expect(settled).toHaveLength(1)
    expect(settled[0]).toBe(previous[1])
  })

  it('does not reuse across a reorder that leaves the array otherwise equal', () => {
    const previous = [said({ key: 'a', text: 'one' }), said({ key: 'b', text: 'two' })]
    const next = [said({ key: 'b', text: 'two' }), said({ key: 'a', text: 'one' })]

    const settled = stabilisedEntries({ previous, next })

    expect(settled).not.toBe(previous)
    expect(settled[0]).toBe(previous[1])
    expect(settled[1]).toBe(previous[0])
  })
})
