import { describe, expect, it } from 'bun:test'

import {
  buildWarpCwdSequence,
  buildWarpNotificationSequence,
  truncateForWarpNotification,
} from '../sequence'

describe('buildWarpCwdSequence', () => {
  it('emits a file URL for the host and path, ST-terminated', () => {
    expect(buildWarpCwdSequence({ cwd: '/Users/dennis/atlas', host: 'mac.local' })).toBe(
      '\x1b]7;file://mac.local/Users/dennis/atlas\x1b\\',
    )
  })

  it('percent-encodes spaces and percent signs only', () => {
    expect(buildWarpCwdSequence({ cwd: '/my dir/100% sure', host: 'h' })).toBe(
      '\x1b]7;file://h/my%20dir/100%25%20sure\x1b\\',
    )
  })
})

describe('buildWarpNotificationSequence', () => {
  it('emits a plain OSC 777 notification', () => {
    expect(buildWarpNotificationSequence({ title: 'Atlas', body: 'done' })).toBe(
      '\x1b]777;notify;Atlas;done\x07',
    )
  })

  it('strips control characters and newlines from the payload', () => {
    const sequence = buildWarpNotificationSequence({
      title: 'At\x07las',
      body: 'line one\nline \x1b two',
    })
    expect(sequence).toBe('\x1b]777;notify;Atlas;line one line  two\x07')
  })

  it('replaces semicolons in the title so the body stays intact', () => {
    const sequence = buildWarpNotificationSequence({ title: 'a;b', body: 'c;d' })
    expect(sequence).toBe('\x1b]777;notify;a:b;c;d\x07')
  })
})

describe('truncateForWarpNotification', () => {
  it('leaves short text alone', () => {
    expect(truncateForWarpNotification({ text: 'short' })).toBe('short')
  })

  it('truncates at the limit with an ellipsis', () => {
    const text = 'b'.repeat(201)
    expect(truncateForWarpNotification({ text })).toBe(`${'b'.repeat(197)}...`)
  })
})
