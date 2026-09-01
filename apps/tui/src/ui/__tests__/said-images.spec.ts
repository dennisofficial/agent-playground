import type { SaidImage } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { saidImageLine } from '../said-images'

const said = (over: Partial<SaidImage> = {}): SaidImage => ({
  path: '/tmp/atlas/pastes/t1/paste-1.png',
  mediaType: 'image/png',
  data: 'A'.repeat(4096),
  width: 560,
  height: 280,
  ...over,
})

describe('what a picture that rode along reads as in the transcript', () => {
  it('names the file, its size in pixels, and what it cost', () => {
    expect(saidImageLine(said())).toBe('▣ paste-1.png · 560×280 · ~200 tokens')
  })

  it('leaves out the size and the cost when the dimensions were never read', () => {
    expect(saidImageLine(said({ width: undefined, height: undefined }))).toBe('▣ paste-1.png')
  })
})
