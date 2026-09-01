import { beforeEach, describe, expect, test } from 'bun:test'

import { applyTranscriptRows, transcriptRows } from '../viewport-rows-store'

beforeEach(() => applyTranscriptRows(0))

describe('the transcript row count', () => {
  test('starts unmeasured, so a caller can tell it apart from a real zero', () => {
    expect(transcriptRows()).toBe(0)
  })

  test('takes whole rows only', () => {
    applyTranscriptRows(28.9)
    expect(transcriptRows()).toBe(28)
  })

  test('refuses a negative measurement', () => {
    applyTranscriptRows(-4)
    expect(transcriptRows()).toBe(0)
  })
})
