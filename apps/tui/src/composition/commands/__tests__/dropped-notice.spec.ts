import { describe, expect, it } from 'bun:test'

import { droppedNotice } from '../dropped-notice'

describe('droppedNotice', () => {
  it('says nothing when nothing was dropped', () => {
    expect(droppedNotice({ command: 'new', messages: 0, commands: [] })).toBeNull()
  })

  it('names one dropped message without a count', () => {
    expect(droppedNotice({ command: 'new', messages: 1, commands: [] })).toBe(
      '/new dropped a queued message',
    )
  })

  it('counts several dropped messages', () => {
    expect(droppedNotice({ command: 'resume', messages: 2, commands: [] })).toBe(
      '/resume dropped 2 queued messages',
    )
  })

  it('names the queued commands that will never run', () => {
    expect(droppedNotice({ command: 'restart', messages: 0, commands: ['compact'] })).toBe(
      '/restart dropped /compact',
    )
  })

  it('joins dropped messages and commands into one sentence', () => {
    expect(droppedNotice({ command: 'new', messages: 2, commands: ['compact'] })).toBe(
      '/new dropped 2 queued messages and /compact',
    )
  })
})
