import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hostSandboxEnvironment,
  mountedAtlasHomeSubtrees,
  sandboxConfigFromHost,
} from '../host-environment'
import { EMountMode } from '../../image/mounts'
import { EBuildContext } from '../../image/build'
import { EConfigSource, EImageKind, type ContainerResolution } from '../../image/resolve'

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
  let home: string
  let env: Record<string, string | undefined>
  let agent: ReturnType<typeof Bun.listen> | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'atlas-hostenv-'))
    env = { HOME: home, PATH: home }
    await writeFile(
      join(home, 'gpgconf'),
      '#!/bin/sh\n[ "$1 $2" = "--list-dirs agent-extra-socket" ] || exit 1\nprintf \'%s\\n\' "${GNUPGHOME:-$HOME/.gnupg}/S.gpg-agent.extra"\n',
      { mode: 0o755 },
    )
  })

  afterEach(async () => {
    agent?.stop(true)
    agent = undefined
    await rm(home, { recursive: true, force: true })
  })

  it('carries the operator uid, gid and home', () => {
    const environment = hostSandboxEnvironment({ env })

    expect(environment.uid).toBe(hostUid())
    expect(environment.gid).toBe(hostGid())
    expect(environment.home).toBe(home)
  })

  it('omits a missing ssh agent socket', () => {
    expect(hostSandboxEnvironment({ env }).sshAuthSock).toBeUndefined()
    env.SSH_AUTH_SOCK = join(home, 'missing.socket')
    expect(hostSandboxEnvironment({ env }).sshAuthSock).toBeUndefined()
  })

  it('mounts a gitconfig only when the operator has one', async () => {
    expect(hostSandboxEnvironment({ env }).gitconfigPath).toBeUndefined()
    const gitconfig = join(home, '.gitconfig')
    await writeFile(gitconfig, '[user]\n\tname = Operator\n')

    expect(hostSandboxEnvironment({ env }).gitconfigPath).toBe(gitconfig)
  })

  it.each(['.gnupg', 'custom-gnupg'])(
    'discovers only the public keyring under %s',
    async (directory) => {
      const gpgHome = join(home, directory)
      if (directory !== '.gnupg') {
        env.GNUPGHOME = gpgHome
        await mkdir(join(home, '.gnupg'))
        await writeFile(join(home, '.gnupg', 'pubring.kbx'), 'unused default keyring fixture')
      }
      const pubring = join(gpgHome, 'pubring.kbx')
      const socket = join(gpgHome, 'S.gpg-agent.extra')
      await mkdir(join(gpgHome, 'private-keys-v1.d'), { recursive: true })
      await writeFile(join(gpgHome, 'private-keys-v1.d', 'key.key'), 'private key fixture')
      await writeFile(join(gpgHome, 'secring.gpg'), 'private keyring fixture')
      agent = Bun.listen({ unix: socket, socket: { data() {} } })

      expect(hostSandboxEnvironment({ env }).gpgAgentExtraSocket).toBe(socket)
      expect(hostSandboxEnvironment({ env }).gpgPubringPath).toBeUndefined()
      await mkdir(pubring)
      expect(hostSandboxEnvironment({ env }).gpgPubringPath).toBeUndefined()
      await rm(pubring, { recursive: true })
      await writeFile(pubring, 'public keyring fixture')

      expect(hostSandboxEnvironment({ env }).gpgPubringPath).toBe(pubring)
    },
  )

  it.each([
    { name: 'missing gpgconf', script: undefined },
    { name: 'failed gpgconf', script: '#!/bin/sh\nexit 1\n' },
    { name: 'empty gpgconf output', script: '#!/bin/sh\nexit 0\n' },
    {
      name: 'non-socket gpgconf output',
      script: '#!/bin/sh\nprintf \'%s\\n\' "$HOME/.gnupg/pubring.kbx"\n',
    },
    { name: 'missing socket', script: '#!/bin/sh\nprintf \'%s\\n\' "$HOME/missing.socket"\n' },
  ])('omits the agent and public keyring for $name', async ({ script }) => {
    const pubring = join(home, '.gnupg', 'pubring.kbx')
    await mkdir(join(home, '.gnupg'))
    await writeFile(pubring, 'public keyring fixture')
    if (script === undefined) await rm(join(home, 'gpgconf'))
    else await writeFile(join(home, 'gpgconf'), script)

    const environment = hostSandboxEnvironment({ env })
    expect(environment.gpgAgentExtraSocket).toBeUndefined()
    expect(environment.gpgPubringPath).toBeUndefined()
  })

  it('discovers only the existing ssh known_hosts file, not private keys or directories', async () => {
    const knownHosts = join(home, '.ssh', 'known_hosts')
    expect(hostSandboxEnvironment({ env }).sshKnownHostsPath).toBeUndefined()
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh', 'id_ed25519'), 'private key fixture')
    expect(hostSandboxEnvironment({ env }).sshKnownHostsPath).toBeUndefined()
    await mkdir(knownHosts)
    expect(hostSandboxEnvironment({ env }).sshKnownHostsPath).toBeUndefined()
    await rm(knownHosts, { recursive: true })
    await writeFile(knownHosts, 'github.com ssh-ed25519 AAAA')

    expect(hostSandboxEnvironment({ env }).sshKnownHostsPath).toBe(knownHosts)
  })

  it('composes a sandbox config for a worktree out of the host environment and limits', () => {
    const config = sandboxConfigFromHost({
      worktree: '/Users/operator/Developer/project',
      limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
    })

    expect(config.image).toBe('ghcr.io/dennisofficial/atlas-sandbox:latest')
    expect(config.worktree).toBe('/Users/operator/Developer/project')
    expect(config.limits).toEqual({ cpus: 2, memoryBytes: 4 * 1024 ** 3 })
    expect(config.uid).toBe(hostUid())
    expect(config.dockerSocket.length).toBeGreaterThan(0)
  })

  const resolution = (image: ContainerResolution['image']): ContainerResolution => ({
    image,
    setup: 'bun install',
    start: 'docker compose up -d',
    env: {},
    mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
    source: EConfigSource.ContainerJson,
    notes: [],
    refusals: [],
  })

  it('carries declared container env into the sandbox config', () => {
    const config = sandboxConfigFromHost({
      worktree: '/Users/operator/Developer/project',
      limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
      resolution: {
        ...resolution({ kind: EImageKind.Image, reference: 'repo/toolchain:latest' }),
        env: { TURBO_CACHE_DIR: '/tmp/turbo-cache' },
      },
    })

    expect(config.env).toEqual({ TURBO_CACHE_DIR: '/tmp/turbo-cache' })
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

  it('maps a Dockerfile resolution onto the sandbox config as a path to build from', () => {
    const config = sandboxConfigFromHost({
      worktree: '/Users/operator/Developer/project',
      limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
      resolution: resolution({
        kind: EImageKind.Dockerfile,
        path: '/Users/operator/Developer/project/.atlas/Dockerfile',
        context: EBuildContext.Directory,
      }),
    })

    expect(config.dockerfile).toEqual({
      path: '/Users/operator/Developer/project/.atlas/Dockerfile',
      context: EBuildContext.Directory,
    })
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
