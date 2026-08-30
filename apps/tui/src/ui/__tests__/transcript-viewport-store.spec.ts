import { afterEach, describe, expect, it } from 'bun:test'

import {
  applyTranscriptViewport,
  AT_REST,
  resetTranscriptViewport,
  subscribeTranscriptViewport,
  transcriptViewport,
  transcriptViewportVersion,
} from '../transcript-viewport-store'

afterEach(() => {
  resetTranscriptViewport()
})

describe('where the transcript is sitting, as one fact', () => {
  it('starts tailing with nothing held at the top', () => {
    expect(transcriptViewport()).toEqual(AT_REST)
  })

  it('bumps a numeric version, which is what useSyncExternalStore snapshots', () => {
    const before = transcriptViewportVersion()
    applyTranscriptViewport({ tailing: false, peekKey: 'u2' })
    expect(transcriptViewportVersion()).toBe(before + 1)
  })

  it('stays quiet when told what it already knows', () => {
    applyTranscriptViewport({ tailing: false, peekKey: 'u2' })
    const settled = transcriptViewportVersion()

    let woken = 0
    const unsubscribe = subscribeTranscriptViewport(() => {
      woken += 1
    })
    applyTranscriptViewport({ tailing: false, peekKey: 'u2' })
    unsubscribe()

    expect(woken).toBe(0)
    expect(transcriptViewportVersion()).toBe(settled)
  })

  it('wakes a subscriber when the peek moves without the tailing changing', () => {
    applyTranscriptViewport({ tailing: false, peekKey: 'u2' })

    let woken = 0
    const unsubscribe = subscribeTranscriptViewport(() => {
      woken += 1
    })
    applyTranscriptViewport({ tailing: false, peekKey: 'u1' })
    unsubscribe()

    expect(woken).toBe(1)
    expect(transcriptViewport().peekKey).toBe('u1')
  })
})
