import type { SaidImage } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { saidImageText } from '../said-images'

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
    expect(saidImageText(said())).toBe('paste-1.png · 560×280 · ~200 tokens')
  })

  it('leaves out the size and the cost when the dimensions were never read', () => {
    expect(saidImageText(said({ width: undefined, height: undefined }))).toBe('paste-1.png')
  })
})
