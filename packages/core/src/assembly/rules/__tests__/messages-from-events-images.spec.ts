import { describe, expect, it } from 'bun:test'

import { MAX_INLINE_BYTES } from '../../../images/limits'
import type { Assembled } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'

const empty: Assembled = { system: [], messages: [] }

const SHOT = {
  path: '/tmp/atlas/shot.png',
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
  width: 560,
  height: 280,
}

/** Four base64 characters per three bytes, so this is comfortably past the inline ceiling. */
const PAST_THE_CEILING = { ...SHOT, data: 'A'.repeat(MAX_INLINE_BYTES * 2) }

const contentOf = (event: Parameters<typeof log>[0][number]) =>
  messagesFromEvents()(empty, contextFor({ events: log([event]) })).messages[0]?.message.content

describe('a message somebody attached a picture to', () => {
  it('reaches the model as the words followed by the image', () => {
    expect(contentOf({ type: 'user-said', text: 'why is this broken', images: [SHOT] })).toEqual([
      { type: 'text', text: 'why is this broken' },
      {
        type: 'image',
        data: SHOT.data,
        mediaType: 'image/png',
        source: SHOT.path,
        width: SHOT.width,
        height: SHOT.height,
      },
    ])
  })

  it('carries the dimensions the event already knew, so nothing decodes the bytes to find them', () => {
    const image = contentOf({ type: 'user-said', text: 'look', images: [SHOT] })?.[1]

    expect(image?.type === 'image' ? [image.width, image.height] : null).toEqual([
      SHOT.width,
      SHOT.height,
    ])
  })

  it('carries the file it came from, so a downgraded image can still be read again', () => {
    const content = contentOf({ type: 'user-said', text: 'look', images: [SHOT] })
    const image = content?.[1]

    expect(image?.type === 'image' ? image.source : null).toBe(SHOT.path)
  })

  it('is a plain text message when nobody attached one', () => {
    expect(contentOf({ type: 'user-said', text: 'why is this broken' })).toEqual([
      { type: 'text', text: 'why is this broken' },
    ])
  })

  it('names a picture too heavy to inline instead of sending bytes that fail the step', () => {
    expect(
      contentOf({ type: 'user-said', text: 'look at this', images: [PAST_THE_CEILING] }),
    ).toEqual([{ type: 'text', text: 'look at this\n[image /tmp/atlas/shot.png · 560×280]' }])
  })

  it('shows the ones it can and names the ones it cannot, in one message', () => {
    const content = contentOf({
      type: 'user-said',
      text: 'both of these',
      images: [SHOT, PAST_THE_CEILING],
    })

    expect(content).toHaveLength(2)
    expect(content?.[0]).toEqual({
      type: 'text',
      text: 'both of these\n[image /tmp/atlas/shot.png · 560×280]',
    })
    expect(content?.[1]?.type).toBe('image')
  })
})
