import { describe, expect, it } from 'bun:test'

import { EMountMode, mountBind } from '../mounts'

describe('mountBind', () => {
  it('mounts a read-only mount at its own absolute path', () => {
    expect(mountBind({ path: '/Users/operator/Developer/other', mode: EMountMode.ReadOnly })).toBe(
      '/Users/operator/Developer/other:/Users/operator/Developer/other:ro',
    )
  })

  it('renders a read-write mount without a suffix, like the worktree bind', () => {
    expect(mountBind({ path: '/data/shared', mode: EMountMode.ReadWrite })).toBe(
      '/data/shared:/data/shared',
    )
  })
})
