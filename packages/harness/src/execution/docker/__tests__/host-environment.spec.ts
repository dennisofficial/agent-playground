import { describe, expect, it } from 'bun:test'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hostSandboxEnvironment, sandboxConfigFromHost } from '../host-environment'
import { EMountMode } from '../../image/mounts'
import {
  EConfigSource,
  EImageKind,
  type ContainerResolution,
} from '../../image/resolve'

const hostUid = (): number => {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('this platform has no uid')
  return uid
}

const hostGid = (): number => {
  const gid = process.getgid?.()
  if (gid === undefined) throw new Error('this platform has no gid')
  return gid
}

describe('hostSandboxEnvironment', () => {
  it('carries the operator uid, gid and home', () => {
    const environment = hostSandboxEnvironment({ env: { HOME: '/Users/operator' } })

    expect(environment.uid).toBe(hostUid())
    expect(environment.gid).toBe(hostGid())
    expect(environment.home).toBe('/Users/operator')
  })

  it('forwards an ssh agent socket only when the path is real', () => {
    expect(hostSandboxEnvironment({ env: { HOME: '/tmp' } }).sshAuthSock).toBeUndefined()
    expect(
      hostSandboxEnvironment({ env: { HOME: '/tmp', SSH_AUTH_SOCK: '/no/such/socket' } })
        .sshAuthSock,
    ).toBeUndefined()
  })

  it('mounts a gitconfig only when the operator has one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'atlas-dev-hostenv-'))
    try {
      expect(hostSandboxEnvironment({ env: { HOME: home } }).gitconfigPath).toBeUndefined()

      const gitconfig = join(home, '.gitconfig')
      await writeFile(gitconfig, '[user]\n\tname = Operator\n')

      expect(hostSandboxEnvironment({ env: { HOME: home } }).gitconfigPath).toBe(gitconfig)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports a gpg extra socket as a path or not at all', () => {
    const environment = hostSandboxEnvironment({ env: { HOME: '/tmp' } })

    if (environment.gpgAgentExtraSocket !== undefined) {
      expect(environment.gpgAgentExtraSocket).toContain('S.gpg-agent.extra')
    }
  })

  it('composes a sandbox config for a worktree out of the host environment and limits', () => {
    const config = sandboxConfigFromHost({
      worktree: '/Users/operator/Developer/project',
      limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
    })

    expect(config.image).toBe('node:22-slim')
    expect(config.worktree).toBe('/Users/operator/Developer/project')
    expect(config.limits).toEqual({ cpus: 2, memoryBytes: 4 * 1024 ** 3 })
    expect(config.uid).toBe(hostUid())
    expect(config.dockerSocket.length).toBeGreaterThan(0)
  })

  const resolution = (image: ContainerResolution['image']): ContainerResolution => ({
    image,
    setup: 'bun install',
    start: 'docker compose up -d',
    mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
    source: EConfigSource.ContainerJson,
    notes: [],
    refusals: [],
  })

  it('maps a resolved container config onto the sandbox config', () => {
    const config = sandboxConfigFromHost({
      worktree: '/Users/operator/Developer/project',
      limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
      resolution: resolution({ kind: EImageKind.Image, reference: 'repo/toolchain:latest' }),
    })

    expect(config.image).toBe('repo/toolchain:latest')
    expect(config.setup).toBe('bun install')
    expect(config.start).toBe('docker compose up -d')
    expect(config.mounts).toEqual([
      { path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly },
    ])
  })

  it('refuses a Dockerfile resolution, because building is not wired — name an image instead', () => {
    expect(() =>
      sandboxConfigFromHost({
        worktree: '/Users/operator/Developer/project',
        limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
        resolution: resolution({
          kind: EImageKind.Dockerfile,
          path: '/Users/operator/Developer/project/.atlas/Dockerfile',
        }),
      }),
    ).toThrow(/container\.json/)
  })
})
