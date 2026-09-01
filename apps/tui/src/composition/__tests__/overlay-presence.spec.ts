import { describe, expect, it } from 'bun:test'

import {
  composerCovered,
  covering,
  keyOwners,
  transcriptCovered,
  type OverlayPresence,
} from '../overlay-presence'

const noop = (): void => {}

const shut = covering(false, noop)

const narrowing: OverlayPresence = {
  open: true,
  coversComposer: true,
  coversTranscript: false,
}

describe('what an open overlay covers', () => {
  it('takes the caret and withholds pictures when it paints over both', () => {
    const overlays = [covering(true, noop)]

    expect(composerCovered(overlays)).toBe(true)
    expect(transcriptCovered(overlays)).toBe(true)
  })

  it('leaves pictures alone for something that narrows the transcript rather than covering it', () => {
    expect(composerCovered([narrowing])).toBe(true)
    expect(transcriptCovered([narrowing])).toBe(false)
  })

  it('counts nothing a closed overlay would have covered', () => {
    expect(composerCovered([shut])).toBe(false)
    expect(transcriptCovered([shut])).toBe(false)
  })
})

describe('the keyboard owners', () => {
  it('keeps the order it was given, which is the order they stack', () => {
    const first = (): void => {}
    const second = (): void => {}

    const owners = keyOwners([covering(true, first), covering(true, second)])

    expect(owners.map((owner) => owner.handleKey)).toEqual([first, second])
  })

  it('leaves out what has no keys of its own rather than ranking it', () => {
    const overlays: readonly OverlayPresence[] = [
      { open: true, coversComposer: true, coversTranscript: true },
      covering(true, noop),
    ]

    expect(keyOwners(overlays)).toHaveLength(1)
  })

  it('keeps a closed owner in the running order, so opening it does not reshuffle the stack', () => {
    expect(keyOwners([shut, covering(true, noop)]).map((owner) => owner.open)).toEqual([
      false,
      true,
    ])
  })

  it('carries porous through, since it decides whether a key falls back to the global chords', () => {
    const overlays = [{ ...covering(true, noop), porous: true }]

    expect(keyOwners(overlays)[0]?.porous).toBe(true)
  })

  it('omits porous rather than passing it as false, which the owner reads as absent', () => {
    expect(keyOwners([covering(true, noop)])[0]).not.toHaveProperty('porous')
  })
})
