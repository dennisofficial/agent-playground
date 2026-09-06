import type { TextChunk } from '@opentui/core'
import { describe, expect, test } from 'bun:test'

import { beaconHeat, shimmerCrest, WORKING_SHIMMER } from '../shimmer'
import { shimmerText, SHIMMER_TICK_MS } from '../shimmer-frames'
import { shimmerColour, shimmerSpans } from '../shimmer-style'
import { spinnerFrame, theme } from '../theme'

const LABEL = 'Thinking for 12s (↓ 1.2k tokens · esc to interrupt)'

const TEXT_OFFSET = 2

const ERROR_BASE = theme.error


const expectedChunks = (now: number, label: string, base?: string): { text: string; fg: string | null }[] => {
  const cells = [...label].length + TEXT_OFFSET
  const crest = shimmerCrest({ nowMs: now, cells, spec: WORKING_SHIMMER })
  return [
    { text: spinnerFrame(now), fg: shimmerColour(beaconHeat({ crest, spec: WORKING_SHIMMER }), base) },
    { text: ' ', fg: null },
    ...shimmerSpans({
      text: label,
      crest,
      spec: WORKING_SHIMMER,
      offset: TEXT_OFFSET,
      ...(base === undefined ? {} : { base }),
    }).map((span) => ({
      text: span.text,
      fg: span.fg ?? null,
    })),
  ]
}

const hexOf = (rgba: { toInts(): number[] }): string =>
  `#${rgba
    .toInts()
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`

const actualChunks = (now: number, label: string, base?: string): { text: string; fg: string | null }[] =>
  shimmerText({ label, base, now }).chunks.map((chunk) => ({
    text: chunk.text,
    fg: chunk.fg === undefined ? null : hexOf(chunk.fg),
  }))

describe('shimmerText', () => {
  test('matches the span renderer at every tick across several cycles', () => {
    for (let index = 0; index < 300; index += 1) {
      const now = index * SHIMMER_TICK_MS
      expect(actualChunks(now, LABEL), `tick ${index}`).toEqual(expectedChunks(now, LABEL))
    }
  })

  test('honours a base colour the same way', () => {
    const label = 'Retrying in 9s (attempt 2/5): rate limited'
    for (let index = 0; index < 50; index += 1) {
      const now = index * SHIMMER_TICK_MS
      expect(actualChunks(now, label, ERROR_BASE), `tick ${index}`).toEqual(
        expectedChunks(now, label, ERROR_BASE),
      )
    }
  })
})
