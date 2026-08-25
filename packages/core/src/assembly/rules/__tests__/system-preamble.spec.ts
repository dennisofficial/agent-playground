import { describe, expect, it } from 'bun:test'

import type { Assembled } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { MINIMAL_PREAMBLE, systemPreamble } from '../system-preamble'

const ctx = contextFor({ events: log([]) })

describe('systemPreamble', () => {
  it('appends one system block holding the minimal preamble', () => {
    const assembled = systemPreamble()({ system: [], messages: [] }, ctx)

    expect(assembled.system).toEqual([{ text: MINIMAL_PREAMBLE }])
  })

  it('leaves messages and earlier system blocks alone', () => {
    const input: Assembled = {
      system: [{ text: 'earlier' }],
      messages: [
        {
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          origin: { eventId: log([{ type: 'user-said', text: 'hello' }])[0]!.id, seq: 1 },
        },
      ],
    }

    const assembled = systemPreamble()(input, ctx)

    expect(assembled.system.map((block) => block.text)).toEqual(['earlier', MINIMAL_PREAMBLE])
    expect(assembled.messages).toEqual(input.messages)
  })
})
