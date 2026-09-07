import { describe, expect, it } from 'bun:test'

import { EMountMode } from '../../image/mounts'
import { declaredMountsLabel, encodeDeclaredMounts } from '../mount-drift'
import {
  CONTAINER_GNUPG_HOME,
  sandboxCreateBody,
  sandboxNameFor,
  worktreeLabel,
  type SandboxConfig,
} from '../sandbox'

const CONFIG: SandboxConfig = {
  image: 'node:22-slim',
  worktree: '/Users/operator/Developer/project/.atlas/worktrees/feature',
  uid: 501,
  gid: 20,
  home: '/Users/operator',
  limits: { cpus: 2, memoryBytes: 4 * 1024 ** 3 },
  dockerSocket: '/var/run/docker.sock',
  sshAuthSock: '/var/run/com.apple.launchd.abc/Listeners',
  gpgAgentExtraSocket: '/Users/operator/.gnupg/S.gpg-agent.extra',
  gitconfigPath: '/Users/operator/.gitconfig',
}

const bindsOf = (config: SandboxConfig): readonly string[] => {
  const body = sandboxCreateBody(config)
  return body.HostConfig?.Binds ?? []
}

describe('sandboxCreateBody', () => {
  it('carries the probed github token as GH_TOKEN, and omits it when there is none', () => {
    expect(sandboxCreateBody({ ...CONFIG, githubToken: 'gho_fixture' }).Env).toContain(
      'GH_TOKEN=gho_fixture',
    )
    expect(sandboxCreateBody(CONFIG).Env?.some((one) => one.startsWith('GH_TOKEN='))).toBe(false)
  })

  it('appends declared env after the computed env, winning any collision', () => {
    const env = sandboxCreateBody({
      ...CONFIG,
      env: { HOME: '/declared/home', TURBO_CACHE_DIR: '/tmp/turbo-cache' },
    }).Env ?? []

    expect(env).toContain('TURBO_CACHE_DIR=/tmp/turbo-cache')
    expect(env.filter((one) => one.startsWith('HOME='))).toEqual(['HOME=/declared/home'])
  })

  it('bind-mounts the worktree at its identical absolute path', () => {
    const body = sandboxCreateBody(CONFIG)
    const binds = body.HostConfig?.Binds ?? []

    const worktreeBinds = binds.filter((bind) => bind.includes(CONFIG.worktree))
    expect(worktreeBinds).toHaveLength(1)

    const [source, destination] = (worktreeBinds[0] ?? '').split(':')
    expect(source).toBe(CONFIG.worktree)
    expect(destination).toBe(CONFIG.worktree)
  })

  it('runs as the operator, not as root', () => {
    expect(sandboxCreateBody(CONFIG).User).toBe('501:20')
  })

  it('stamps the worktree label, which is the registry', () => {
    expect(sandboxCreateBody(CONFIG).Labels?.[worktreeLabel('atlas')]).toBe(CONFIG.worktree)
  })

  it('stamps the declared mounts label, which the drift check compares against later', () => {
    const withMounts: SandboxConfig = {
      ...CONFIG,
      mounts: [{ path: '/data/shared', mode: EMountMode.ReadOnly }],
    }

    expect(sandboxCreateBody(withMounts).Labels?.[declaredMountsLabel('atlas')]).toBe(
      encodeDeclaredMounts(withMounts.mounts ?? []),
    )
    expect(sandboxCreateBody(CONFIG).Labels?.[declaredMountsLabel('atlas')]).toBe(
      encodeDeclaredMounts([]),
    )
  })

  it('carries the resource limits through to the daemon', () => {
    const hostConfig = sandboxCreateBody(CONFIG).HostConfig

    expect(hostConfig?.NanoCpus).toBe(2 * 1e9)
    expect(hostConfig?.Memory).toBe(4 * 1024 ** 3)
  })

  it('mounts the host docker socket at its own path for the workload compose stack', () => {
    expect(bindsOf(CONFIG)).toContain('/var/run/docker.sock:/var/run/docker.sock')
  })

  it('names the compose project after the worktree key so stacks never collide', () => {
    const env = sandboxCreateBody(CONFIG).Env ?? []
    const compose = env.find((one) => one.startsWith('COMPOSE_PROJECT_NAME='))

    expect(compose).toBe(`COMPOSE_PROJECT_NAME=${sandboxNameFor({ prefix: 'atlas', worktree: CONFIG.worktree })}`)
  })

  it('derives a stable name from the worktree path', () => {
    const first = sandboxNameFor({ prefix: 'atlas', worktree: CONFIG.worktree })
    const again = sandboxNameFor({ prefix: 'atlas', worktree: CONFIG.worktree })
    const other = sandboxNameFor({ prefix: 'atlas', worktree: '/Users/operator/Developer/other' })

    expect(first).toBe(again)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^atlas-[0-9a-f]{12}$/)
  })

  it('forwards the ssh agent socket at its own path and points SSH_AUTH_SOCK at it', () => {
    const body = sandboxCreateBody(CONFIG)

    expect(body.HostConfig?.Binds).toContain(
      `${CONFIG.sshAuthSock ?? ''}:${CONFIG.sshAuthSock ?? ''}`,
    )
    expect(body.Env).toContain(`SSH_AUTH_SOCK=${CONFIG.sshAuthSock ?? ''}`)
  })

  it("mounts the operator's gitconfig read-only and keeps HOME pointing at it", () => {
    const body = sandboxCreateBody(CONFIG)

    expect(body.HostConfig?.Binds).toContain(`${CONFIG.gitconfigPath ?? ''}:${CONFIG.gitconfigPath ?? ''}:ro`)
    expect(body.Env).toContain(`HOME=${CONFIG.home}`)
  })

  it('puts the forwarded gpg extra socket where an in-container gpg looks for its agent', () => {
    const body = sandboxCreateBody(CONFIG)

    expect(body.HostConfig?.Binds).toContain(
      `${CONFIG.gpgAgentExtraSocket ?? ''}:${CONTAINER_GNUPG_HOME}/S.gpg-agent`,
    )
    expect(body.Env).toContain(`GNUPGHOME=${CONTAINER_GNUPG_HOME}`)
  })

  it('leaves the identity mounts out entirely when the host has none', () => {
    const bare: SandboxConfig = {
      image: CONFIG.image,
      worktree: CONFIG.worktree,
      uid: CONFIG.uid,
      gid: CONFIG.gid,
      home: CONFIG.home,
      limits: CONFIG.limits,
      dockerSocket: '/var/run/docker.sock',
    }
    const body = sandboxCreateBody(bare)
    const binds = body.HostConfig?.Binds ?? []

    expect(binds).toHaveLength(2)
    expect(body.Env?.some((one) => one.startsWith('SSH_AUTH_SOCK='))).toBe(false)
  })

  it('binds declared extra mounts at their own path, read-only by default', () => {
    const body = sandboxCreateBody({
      ...CONFIG,
      mounts: [
        { path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly },
        { path: '/data/scratch', mode: EMountMode.ReadWrite },
      ],
    })

    expect(body.HostConfig?.Binds).toContain(
      '/Users/operator/Developer/shared-lib:/Users/operator/Developer/shared-lib:ro',
    )
    expect(body.HostConfig?.Binds).toContain('/data/scratch:/data/scratch')
  })

  it('overrides the mounted gitconfig through git env config pairs, because the mount is read-only', () => {
    const env = sandboxCreateBody(CONFIG).Env ?? []

    expect(env).toContain('GIT_CONFIG_COUNT=3')
    expect(env).toContain('GIT_CONFIG_KEY_0=gpg.program')
    expect(env).toContain('GIT_CONFIG_VALUE_0=gpg')
    expect(env).toContain('GIT_CONFIG_KEY_1=safe.directory')
    expect(env).toContain(`GIT_CONFIG_VALUE_1=${CONFIG.worktree}`)
  })

  it('trusts child repositories with a scoped wildcard, including children created after initial config', () => {
    const env = sandboxCreateBody(CONFIG).Env ?? []

    expect(env).toContain('GIT_CONFIG_COUNT=3')
    expect(env).toContain('GIT_CONFIG_KEY_2=safe.directory')
    expect(env).toContain(`GIT_CONFIG_VALUE_2=${CONFIG.worktree}/*`)
  })

  it('never broadens safe.directory to a bare star, keeping the check scoped to the repo', () => {
    const env = sandboxCreateBody(CONFIG).Env ?? []

    expect(env.every((one) => !one.startsWith('GIT_CONFIG_VALUE') || !one.endsWith('=*'))).toBe(true)
  })

  it('mounts the host gpg public keyring read-only beside the forwarded agent socket', () => {
    const body = sandboxCreateBody({ ...CONFIG, gpgPubringPath: '/Users/operator/.gnupg/pubring.kbx' })

    expect(body.HostConfig?.Binds).toContain(
      `/Users/operator/.gnupg/pubring.kbx:${CONTAINER_GNUPG_HOME}/pubring.kbx:ro`,
    )
  })

  it('never mounts the gpg private key stubs — the forwarded agent holds the secrets', () => {
    const body = sandboxCreateBody({ ...CONFIG, gpgPubringPath: '/Users/operator/.gnupg/pubring.kbx' })

    expect(body.HostConfig?.Binds?.some((bind) => bind.includes('private-keys-v1.d'))).toBe(false)
  })

  it('mounts the public keyring only while the agent socket is forwarded', () => {
    const bare: SandboxConfig = {
      image: CONFIG.image,
      worktree: CONFIG.worktree,
      uid: CONFIG.uid,
      gid: CONFIG.gid,
      home: CONFIG.home,
      limits: CONFIG.limits,
      dockerSocket: CONFIG.dockerSocket,
      gpgPubringPath: '/Users/operator/.gnupg/pubring.kbx',
    }

    expect(
      sandboxCreateBody(bare).HostConfig?.Binds?.some((bind) => bind.includes('pubring.kbx')),
    ).toBe(false)
  })

  it('mounts the host ssh known_hosts read-only at its identical path', () => {
    const body = sandboxCreateBody({ ...CONFIG, sshKnownHostsPath: '/Users/operator/.ssh/known_hosts' })

    expect(body.HostConfig?.Binds).toContain(
      '/Users/operator/.ssh/known_hosts:/Users/operator/.ssh/known_hosts:ro',
    )
  })

  it('binds each atlas home subtree read-only at its identical path, never the atlas home root', () => {
    const body = sandboxCreateBody({
      ...CONFIG,
      atlasHomeSubtrees: ['/Users/operator/.atlas/memory', '/Users/operator/.atlas/skills'],
    })
    const binds = body.HostConfig?.Binds ?? []

    expect(binds).toContain('/Users/operator/.atlas/memory:/Users/operator/.atlas/memory:ro')
    expect(binds).toContain('/Users/operator/.atlas/skills:/Users/operator/.atlas/skills:ro')
    expect(binds.some((bind) => bind.startsWith('/Users/operator/.atlas:'))).toBe(false)
  })
})
