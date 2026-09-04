import { describe, expect, it } from 'bun:test'

import { EMountMode } from '../mounts'
import { parseContainerJson, parseDevcontainerJson } from '../parse'
import { EConfigRefusal } from '../refusals'

const FILE = '/project/.atlas/container.json'

describe('parseContainerJson', () => {
  it('parses a full config, defaulting mounts to read-only', () => {
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({
        image: 'repo/toolchain:latest',
        setup: 'bun install',
        start: 'docker compose up -d',
        mounts: [{ path: '/Users/operator/Developer/shared-lib' }],
      }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.config).toEqual({
      image: 'repo/toolchain:latest',
      setup: 'bun install',
      start: 'docker compose up -d',
    })
    expect(parsed.mounts).toEqual([
      { path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly },
    ])
    expect(parsed.refusals).toEqual([])
  })

  it('parses an explicit read-write mount through the enum, never a cast', () => {
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({ mounts: [{ path: '/data/scratch', mode: 'rw' }] }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mounts).toEqual([{ path: '/data/scratch', mode: EMountMode.ReadWrite }])
  })

  it('normalizes doubled separators and trailing slashes rather than refusing them', () => {
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({ mounts: [{ path: '/Users/operator//Developer/lib/' }] }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mounts).toEqual([
      { path: '/Users/operator/Developer/lib', mode: EMountMode.ReadOnly },
    ])
  })

  it('refuses a file that is not JSON, naming the file and the reason', () => {
    const parsed = parseContainerJson({ file: FILE, text: '{ not json' })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.refusal.refusal).toBe(EConfigRefusal.NotJson)
    expect(parsed.refusal.file).toBe(FILE)
    expect(parsed.refusal.detail.length).toBeGreaterThan(0)
  })

  it('refuses a mount mode outside the enum instead of coercing it', () => {
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({ mounts: [{ path: '/data', mode: 'shared-ro' }] }),
    })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.refusal.refusal).toBe(EConfigRefusal.BadShape)
    expect(parsed.refusal.detail).toContain('mode')
  })

  it('refuses unknown keys rather than silently dropping a typo', () => {
    const parsed = parseContainerJson({ file: FILE, text: JSON.stringify({ immage: 'node:22' }) })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.refusal.refusal).toBe(EConfigRefusal.BadShape)
    expect(parsed.refusal.detail).toContain('immage')
  })

  it('drops a relative mount with a named refusal and keeps the valid ones', () => {
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({ mounts: [{ path: 'relative/dir' }, { path: '/data/ok' }] }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mounts).toEqual([{ path: '/data/ok', mode: EMountMode.ReadOnly }])
    expect(parsed.refusals).toHaveLength(1)
    expect(parsed.refusals[0]?.refusal).toBe(EConfigRefusal.MountRelative)
    expect(parsed.refusals[0]?.detail).toContain('relative/dir')
  })

  it('refuses a mount with a .. component', () => {
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({ mounts: [{ path: '/Users/operator/../operator' }] }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mounts).toEqual([])
    expect(parsed.refusals[0]?.refusal).toBe(EConfigRefusal.MountDotDot)
  })

  it('refuses an over-long mount path', () => {
    const long = `/${'a'.repeat(600)}`
    const parsed = parseContainerJson({
      file: FILE,
      text: JSON.stringify({ mounts: [{ path: long }] }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.refusals[0]?.refusal).toBe(EConfigRefusal.MountOverLong)
  })

  it.each([
    ['/etc', 'a reserved path itself'],
    ['/etc/ssl', 'a path nested under a reserved one'],
    ['/', 'the filesystem root'],
    ['/usr', 'a parent of reserved container paths'],
  ])('refuses %s: %s', (path) => {
    const parsed = parseContainerJson({ file: FILE, text: JSON.stringify({ mounts: [{ path }] }) })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.mounts).toEqual([])
    expect(parsed.refusals[0]?.refusal).toBe(EConfigRefusal.MountReserved)
    expect(parsed.refusals[0]?.detail).toContain(path === '/' ? '/' : path)
  })
})

const DEVFILE = '/project/.devcontainer/devcontainer.json'

describe('parseDevcontainerJson', () => {
  it('reads only image and postCreateCommand and reports what it ignored', () => {
    const parsed = parseDevcontainerJson({
      file: DEVFILE,
      text: JSON.stringify({
        name: 'project dev',
        image: 'mcr.microsoft.com/devcontainers/typescript-node:22',
        postCreateCommand: 'bun install',
        features: { 'ghcr.io/devcontainers/features/docker-in-docker': {} },
        mounts: ['source=/data,target=/data,type=bind'],
        customizations: { vscode: { extensions: ['dbaeumer.vscode-eslint'] } },
      }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.image).toBe('mcr.microsoft.com/devcontainers/typescript-node:22')
    expect(parsed.setup).toBe('bun install')
    expect(parsed.ignored).toContain('features')
    expect(parsed.ignored).toContain('mounts')
    expect(parsed.ignored).toContain('customizations')
    expect(parsed.ignored).not.toContain('image')
    expect(parsed.ignored).not.toContain('postCreateCommand')
  })

  it('ignores a non-string postCreateCommand and says so, rather than doing nothing quietly', () => {
    const parsed = parseDevcontainerJson({
      file: DEVFILE,
      text: JSON.stringify({ image: 'node:22', postCreateCommand: { install: 'bun install' } }),
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.setup).toBeUndefined()
    expect(parsed.ignored.some((one) => one.includes('postCreateCommand'))).toBe(true)
  })

  it('refuses a file that is not JSON, naming the file and the reason', () => {
    const parsed = parseDevcontainerJson({ file: DEVFILE, text: '// comment\n{ "image":' })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.refusal.refusal).toBe(EConfigRefusal.NotJson)
    expect(parsed.refusal.file).toBe(DEVFILE)
  })

  it('refuses an image that is not a string', () => {
    const parsed = parseDevcontainerJson({ file: DEVFILE, text: JSON.stringify({ image: 42 }) })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.refusal.refusal).toBe(EConfigRefusal.BadShape)
  })
})
