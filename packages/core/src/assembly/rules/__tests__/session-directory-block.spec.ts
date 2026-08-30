import { describe, expect, it } from 'bun:test'

import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'
import { sessionDirectoryBlock } from '../session-directory-block'

const PROJECT = '/w'

const assembleWith = (events: ReturnType<typeof log>) => {
  const ctx = contextFor({ events })
  const withMessages = messagesFromEvents()({ system: [], messages: [] }, ctx)
  return sessionDirectoryBlock({ projectDirectory: PROJECT })(withMessages, ctx)
}

const textsOf = (assembled: ReturnType<typeof assembleWith>): string[] =>
  assembled.messages.flatMap((entry) =>
    entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  )

describe('telling the model where the session actually is', () => {
  it('says nothing while the session sits in the project directory', () => {
    const assembled = assembleWith(log([{ type: 'user-said', text: 'hello' }]))

    expect(textsOf(assembled)).toEqual(['hello'])
  })

  it('appends the current directory at the tail, not where the move happened', () => {
    const assembled = assembleWith(
      log([
        { type: 'user-said', text: 'hello' },
        { type: 'cwd-changed', path: '/w/packages/core' },
        { type: 'user-said', text: 'much later' },
      ]),
    )

    const texts = textsOf(assembled)

    expect(texts.at(-1)).toContain('/w/packages/core')
    expect(texts.at(-1)).toContain('rather than another cd')
    expect(texts.slice(0, -1)).toEqual(['hello', 'much later'])
  })

  it('reports the latest move rather than the first', () => {
    const assembled = assembleWith(
      log([
        { type: 'cwd-changed', path: '/w/packages/core' },
        { type: 'cwd-changed', path: '/w/apps/tui' },
        { type: 'user-said', text: 'now what' },
      ]),
    )

    expect(textsOf(assembled).at(-1)).toContain('/w/apps/tui')
  })

  it('falls silent again once a move returns the session to the project directory', () => {
    const assembled = assembleWith(
      log([
        { type: 'cwd-changed', path: '/w/packages/core' },
        { type: 'cwd-changed', path: PROJECT },
        { type: 'user-said', text: 'back home' },
      ]),
    )

    expect(textsOf(assembled)).toEqual(['back home'])
  })

  it('still names the project directory, so relative paths stay unambiguous', () => {
    const assembled = assembleWith(log([{ type: 'cwd-changed', path: '/w/apps/tui' }]))

    expect(textsOf(assembled).at(-1)).toContain(`resolve against the project directory, ${PROJECT}`)
  })
})
