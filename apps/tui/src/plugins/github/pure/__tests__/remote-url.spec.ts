import { describe, expect, it } from 'bun:test'

import { EForge } from '../checkout'
import { forgeOfHost, parseRemoteUrl } from '../remote-url'

describe('parseRemoteUrl', () => {
  it('reads the scp form git writes for an ssh remote', () => {
    expect(parseRemoteUrl({ url: 'git@github.com:dennisofficial/atlas.git' })).toEqual({
      host: 'github.com',
      owner: 'dennisofficial',
      repo: 'atlas',
    })
  })

  it('reads an https remote', () => {
    expect(parseRemoteUrl({ url: 'https://github.com/dennisofficial/atlas.git' })).toEqual({
      host: 'github.com',
      owner: 'dennisofficial',
      repo: 'atlas',
    })
  })

  it('drops the user and the port from an ssh:// remote', () => {
    expect(parseRemoteUrl({ url: 'ssh://git@github.com:22/dennisofficial/atlas.git' })).toEqual({
      host: 'github.com',
      owner: 'dennisofficial',
      repo: 'atlas',
    })
  })

  it('reads a git:// remote with no .git suffix', () => {
    expect(parseRemoteUrl({ url: 'git://github.com/dennisofficial/atlas' })).toEqual({
      host: 'github.com',
      owner: 'dennisofficial',
      repo: 'atlas',
    })
  })

  it('keeps a gitlab subgroup in the owner', () => {
    expect(parseRemoteUrl({ url: 'https://gitlab.com/group/sub/proj.git' })).toEqual({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'proj',
    })
  })

  it('ignores a trailing slash', () => {
    expect(parseRemoteUrl({ url: 'https://github.com/dennisofficial/atlas/' })).toEqual({
      host: 'github.com',
      owner: 'dennisofficial',
      repo: 'atlas',
    })
  })

  it('lowercases the host', () => {
    expect(parseRemoteUrl({ url: 'git@GitHub.COM:dennisofficial/atlas.git' })?.host).toBe(
      'github.com',
    )
  })

  it('refuses a local mirror, a relative path and an empty string', () => {
    expect(parseRemoteUrl({ url: '/Users/x/mirror.git' })).toBeNull()
    expect(parseRemoteUrl({ url: '..' })).toBeNull()
    expect(parseRemoteUrl({ url: '' })).toBeNull()
  })

  it('refuses a url with no owner segment', () => {
    expect(parseRemoteUrl({ url: 'https://github.com/atlas.git' })).toBeNull()
  })

  it('refuses a bare host with no path', () => {
    expect(parseRemoteUrl({ url: 'github.com' })).toBeNull()
    expect(parseRemoteUrl({ url: 'https://github.com' })).toBeNull()
  })

  it('refuses a file:// url, which names no host', () => {
    expect(parseRemoteUrl({ url: 'file:///Users/x/mirror.git' })).toBeNull()
  })

  it('refuses a windows path in either spelling, whose drive letter is not a host', () => {
    expect(parseRemoteUrl({ url: 'C:\\src\\repo' })).toBeNull()
    expect(parseRemoteUrl({ url: 'C:/src/repo' })).toBeNull()
    expect(parseRemoteUrl({ url: 'c:/src/repo.git' })).toBeNull()
  })
})

describe('forgeOfHost', () => {
  it('knows github.com and github enterprise cloud', () => {
    expect(forgeOfHost({ host: 'github.com' })).toBe(EForge.GitHub)
    expect(forgeOfHost({ host: 'acme.ghe.com' })).toBe(EForge.GitHub)
  })

  it('knows the forges that are definitely not github', () => {
    expect(forgeOfHost({ host: 'gitlab.com' })).toBe(EForge.Other)
    expect(forgeOfHost({ host: 'bitbucket.org' })).toBe(EForge.Other)
    expect(forgeOfHost({ host: 'codeberg.org' })).toBe(EForge.Other)
  })

  it('leaves a corporate host unknown so gh may still answer for it', () => {
    expect(forgeOfHost({ host: 'git.acme-corp.internal' })).toBe(EForge.Unknown)
  })
})
