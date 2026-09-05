import { describe, expect, it } from 'bun:test'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hostSandboxEnvironment,
  mountedAtlasHomeSubtrees,
  sandboxConfigFromHost,
} from '../host-environment'
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

describe('mountedAtlasHomeSubtrees', () => {
  const withAtlasHome = async (
    run: (atlasHome: string) => void | Promise<void>,
  ): Promise<void> => {
    const atlasHome = await mkdtemp(join(tmpdir(), 'atlas-dev-home-'))
    try {
      await run(atlasHome)
    } finally {
      await rm(atlasHome, { recursive: true, force: true })
    }
  }

  it('offers each safe subtree that exists, and only those', async () => {
    await withAtlasHome(async (atlasHome) => {
      await mkdir(join(atlasHome, 'memory'))
      await mkdir(join(atlasHome, 'skills'))
      await writeFile(join(atlasHome, 'auth.json'), '{"secret":true}')
      await writeFile(join(atlasHome, 'harness.db'), 'the event log')

      expect(
        mountedAtlasHomeSubtrees({ worktree: '/unrelated/worktree', atlasHome }),
      ).toEqual([join(atlasHome, 'memory'), join(atlasHome, 'skills')])
    })
  })

  it('can never name the atlas home root — the candidate list is four fixed subtrees', async () => {
    await withAtlasHome(async (atlasHome) => {
      await mkdir(join(atlasHome, 'memory'))
      await mkdir(join(atlasHome, 'agents'))
      await mkdir(join(atlasHome, 'projects'))

      const subtrees = mountedAtlasHomeSubtrees({ worktree: '/unrelated/worktree', atlasHome })

      expect(subtrees).not.toContain(atlasHome)
      expect(subtrees.every((subtree) => subtree.startsWith(`${atlasHome}/`))).toBe(true)
    })
  })

  it('skips subtrees the worktree bind already covers, as a source launch under the repo', async () => {
    await withAtlasHome(async (atlasHome) => {
      await mkdir(join(atlasHome, 'memory'))
      const worktree = join(atlasHome, '..')

      expect(mountedAtlasHomeSubtrees({ worktree, atlasHome })).toEqual([])
    })
  })

  it('skips a subtree a declared mount already covers, so Docker never sees a duplicate bind', async () => {
    await withAtlasHome(async (atlasHome) => {
      await mkdir(join(atlasHome, 'memory'))
      await mkdir(join(atlasHome, 'skills'))

      expect(
        mountedAtlasHomeSubtrees({
          worktree: '/unrelated/worktree',
          declared: [{ path: atlasHome, mode: EMountMode.ReadOnly }],
          atlasHome,
        }),
      ).toEqual([])
    })
  })

  it('lands on the sandbox config, honouring an explicit list over probing', async () => {
    await withAtlasHome(async (atlasHome) => {
      await mkdir(join(atlasHome, 'memory'))
      const previous = process.env['ATLAS_HOME']
      process.env['ATLAS_HOME'] = atlasHome
      try {
        const probed = sandboxConfigFromHost({
          worktree: '/unrelated/worktree',
          limits: { cpus: 1, memoryBytes: 1024 ** 3 },
        })
        expect(probed.atlasHomeSubtrees).toEqual([join(atlasHome, 'memory')])

        const explicit = sandboxConfigFromHost({
          worktree: '/unrelated/worktree',
          limits: { cpus: 1, memoryBytes: 1024 ** 3 },
          atlasHomeSubtrees: ['/elsewhere/memory'],
        })
        expect(explicit.atlasHomeSubtrees).toEqual(['/elsewhere/memory'])
      } finally {
        if (previous === undefined) delete process.env['ATLAS_HOME']
        else process.env['ATLAS_HOME'] = previous
      }
    })
  })
})
