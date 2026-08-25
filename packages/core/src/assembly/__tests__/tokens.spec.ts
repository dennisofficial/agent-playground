import { describe, expect, it } from 'bun:test'

import { toEventId } from '../../events/ids'
import type { Assembled } from '../assembled'
import { estimateTokens } from '../tokens'

const origin = { eventId: toEventId('event-1'), seq: 1 }

describe('estimateTokens', () => {
  it('counts an empty prompt as nothing', () => {
    expect(estimateTokens({ system: [], messages: [] })).toBe(0)
  })

  it('counts system blocks and message parts at four characters per token', () => {
    const assembled: Assembled = {
      system: [{ text: '12345678' }],
      messages: [
        {
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '1234' },
              { type: 'text', text: '123456789012' },
            ],
          },
          origin,
        },
      ],
    }

    expect(estimateTokens(assembled)).toBe(2 + 1 + 3)
  })
})
