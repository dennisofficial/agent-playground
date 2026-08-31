import { describe, expect, it } from 'bun:test'

import { browserLaunch } from '../open-url'

const URL = 'https://claude.com/cai/oauth/authorize?code=true'

describe('browserLaunch', () => {
  it('hands the URL to the macOS opener', () => {
    expect(browserLaunch({ platform: 'darwin', url: URL })).toEqual({
      command: 'open',
      args: [URL],
    })
  })

  it('keeps the empty title argument Windows start needs before the URL', () => {
    expect(browserLaunch({ platform: 'win32', url: URL })).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', URL],
    })
  })

  it('falls back to xdg-open everywhere else', () => {
    expect(browserLaunch({ platform: 'linux', url: URL })).toEqual({
      command: 'xdg-open',
      args: [URL],
    })
  })
})
