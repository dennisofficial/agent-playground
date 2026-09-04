import { describe, expect, it } from 'bun:test'

import { buildWarpCwdSequence } from '../sequence'

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
