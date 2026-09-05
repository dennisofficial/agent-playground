import { afterEach, describe, expect, it } from 'bun:test'

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DockerEngine } from '../engine'
import { EMountMode } from '../../image/mounts'
import { runSandboxScript } from '../sandbox-scripts'
import {
  CONTAINER_GNUPG_HOME,
  ensureSandbox,
  findSandbox,
  oversubscriptionWarnings,
  sandboxCreateBody,
  sandboxNameFor,
  worktreeLabel,
  type SandboxConfig,
  type SandboxEngine,
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

    expect(env).toContain('GIT_CONFIG_COUNT=2')
    expect(env).toContain('GIT_CONFIG_KEY_0=gpg.program')
    expect(env).toContain('GIT_CONFIG_VALUE_0=gpg')
    expect(env).toContain('GIT_CONFIG_KEY_1=safe.directory')
    expect(env).toContain(`GIT_CONFIG_VALUE_1=${CONFIG.worktree}`)
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

const SOCKET = '/var/run/docker.sock'
const describeDocker = existsSync(SOCKET) ? describe : describe.skip

const engine = new DockerEngine({ socketPath: SOCKET })
const PREFIX = 'atlas-dev'

const sweep = async (): Promise<void> => {
  const stale = await engine.listContainers({ labels: { [worktreeLabel(PREFIX)]: undefined }, all: true })
  for (const container of stale) await engine.removeContainer({ id: container.id })
}

describeDocker('ensureSandbox against a live daemon', () => {
  afterEach(sweep)

  const worktree = join('/private/tmp', 'atlas-dev-sandbox-worktree')

  const liveConfig = (overrides?: Partial<SandboxConfig>): SandboxConfig => ({
    image: 'node:22-slim',
    worktree,
    uid: 501,
    gid: 20,
    home: '/Users/operator',
    limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
    dockerSocket: SOCKET,
    labelPrefix: PREFIX,
    ...overrides,
  })

  it('creates and starts once, then reuses the same container', async () => {
    const first = await ensureSandbox({ engine, config: liveConfig() })
    expect(first.created).toBe(true)
    expect((await engine.inspectContainer({ id: first.id })).state.running).toBe(true)

    const second = await ensureSandbox({ engine, config: liveConfig() })
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('restarts a stopped sandbox rather than creating a second one', async () => {
    const first = await ensureSandbox({ engine, config: liveConfig() })
    await engine.stopContainer({ id: first.id })

    const second = await ensureSandbox({ engine, config: liveConfig() })

    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
    expect((await engine.inspectContainer({ id: first.id })).state.running).toBe(true)
  })

  it('is discoverable by label from a fresh client, as if the creating process had gone', async () => {
    const created = await ensureSandbox({ engine, config: liveConfig() })

    const anotherClient = new DockerEngine({ socketPath: SOCKET })
    const found = await findSandbox({ engine: anotherClient, prefix: PREFIX, worktree })

    expect(found?.id).toBe(created.id)
  })

  it('reports the worktree mount with source equal to destination in the daemon record', async () => {
    const created = await ensureSandbox({ engine, config: liveConfig() })

    const details = await engine.inspectContainer({ id: created.id })
    const mount = details.mounts.find((one) => one.destination === worktree)

    expect(mount?.source).toBe(worktree)
    expect(mount?.readOnly).toBe(false)
  })

  it('warns rather than letting the OOM killer explain an oversubscribed machine', async () => {
    const info = await engine.info()
    const warnings = await oversubscriptionWarnings({
      engine,
      prefix: PREFIX,
      adding: { cpus: 1, memoryBytes: info.memoryBytes * 2 },
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('memory')
  })

  it('stays quiet when the machine has headroom', async () => {
    const warnings = await oversubscriptionWarnings({
      engine,
      prefix: PREFIX,
      adding: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
    })

    expect(warnings).toEqual([])
  })

  it('runs setup once and start on every ensure, leaving markers in the mounted worktree', async () => {
    const setupMarker = join(worktree, '.atlas-setup-ran')
    const startMarker = join(worktree, '.atlas-start-ran')
    await mkdir(worktree, { recursive: true })
    await rm(setupMarker, { force: true })
    await rm(startMarker, { force: true })

    try {
      const config = liveConfig({
        setup: `touch ${setupMarker}`,
        start: `touch ${startMarker}`,
      })
      await ensureSandbox({ engine, config })

      expect(existsSync(setupMarker)).toBe(true)
      expect(existsSync(startMarker)).toBe(true)

      await rm(setupMarker, { force: true })
      await rm(startMarker, { force: true })
      await ensureSandbox({ engine, config })

      expect(existsSync(setupMarker)).toBe(false)
      expect(existsSync(startMarker)).toBe(true)
    } finally {
      await rm(setupMarker, { force: true })
      await rm(startMarker, { force: true })
    }
  })

  it('reads a mounted memory subtree inside, but cannot see auth.json or write to it', async () => {
    const atlasHome = join('/private/tmp', 'atlas-dev-sandbox-home')
    await mkdir(join(atlasHome, 'memory'), { recursive: true })
    await writeFile(join(atlasHome, 'memory', 'MEMORY.md'), 'remembered')
    await writeFile(join(atlasHome, 'auth.json'), '{"secret":true}')

    try {
      const sandbox = await ensureSandbox({
        engine,
        config: liveConfig({ atlasHomeSubtrees: [join(atlasHome, 'memory')] }),
      })

      const reading = await runSandboxScript({
        engine,
        containerId: sandbox.id,
        script: `cat ${join(atlasHome, 'memory', 'MEMORY.md')}`,
        cwd: worktree,
      })
      expect(reading.exitCode).toBe(0)
      expect(reading.output).toContain('remembered')

      const credentials = await runSandboxScript({
        engine,
        containerId: sandbox.id,
        script: `cat ${join(atlasHome, 'auth.json')}`,
        cwd: worktree,
      })
      expect(credentials.exitCode).not.toBe(0)

      const writing = await runSandboxScript({
        engine,
        containerId: sandbox.id,
        script: `touch ${join(atlasHome, 'memory', 'probe')}`,
        cwd: worktree,
      })
      expect(writing.exitCode).not.toBe(0)
      expect(existsSync(join(atlasHome, 'memory', 'probe'))).toBe(false)
    } finally {
      await rm(atlasHome, { recursive: true, force: true })
    }
  })
})

type RecordedExec = { cmd: readonly string[]; user: string | undefined }

const fakeEngine = (args?: {
  existing?: {
    id: string
    state: string
    mounts: readonly { source: string; destination: string; readOnly: boolean }[]
  }
  exitCodes?: number[]
}): { engine: SandboxEngine; execs: RecordedExec[] } => {
  const execs: RecordedExec[] = []
  const exitCodes = [...(args?.exitCodes ?? [])]

  const engine: SandboxEngine = {
    listContainers: async () =>
      args?.existing === undefined
        ? []
        : [
            {
              id: args.existing.id,
              name: 'atlas-deadbeef1234',
              state: args.existing.state,
              labels: {},
            },
          ],
    inspectContainer: async () => ({
      id: args?.existing?.id ?? 'created-1',
      name: 'atlas-deadbeef1234',
      state: { running: args?.existing?.state === 'running' },
      config: { labels: {}, env: [] },
      mounts: args?.existing?.mounts ?? [],
      ports: [],
      hostConfig: { nanoCpus: 0, memoryBytes: 0 },
    }),
    info: async () => ({ cpus: 64, memoryBytes: 1024 ** 4 }),
    createContainer: async () => ({ id: 'created-1', warnings: [] }),
    startContainer: async () => undefined,
    createExec: async (execArgs) => {
      execs.push({ cmd: execArgs.cmd, user: execArgs.user })
      return { id: `exec-${execs.length}` }
    },
    startExec: async () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    inspectExec: async () => ({ running: false, exitCode: exitCodes.shift() ?? 0 }),
  }

  return { engine, execs }
}

const FAKE_CONFIG: SandboxConfig = {
  image: 'node:22-slim',
  worktree: '/Users/operator/Developer/project',
  uid: 501,
  gid: 20,
  home: '/Users/operator',
  limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
  dockerSocket: '/var/run/docker.sock',
}

const systemMounts = [
  { source: FAKE_CONFIG.worktree, destination: FAKE_CONFIG.worktree, readOnly: false },
  { source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
]

describe('ensureSandbox scripts and drift, against a fake engine', () => {
  it('runs setup once as root at creation, before start', async () => {
    const { engine: fake, execs } = fakeEngine()

    await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git', start: 'docker compose up -d' },
    })

    expect(execs).toHaveLength(2)
    expect(execs[0]?.cmd).toEqual(['sh', '-c', 'apt-get install -y git'])
    expect(execs[0]?.user).toBe('0')
    expect(execs[1]?.cmd).toEqual(['sh', '-c', 'docker compose up -d'])
    expect(execs[1]?.user).toBeUndefined()
  })

  it('runs start but not setup when reusing a container', async () => {
    const { engine: fake, execs } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git', start: 'docker compose up -d' },
    })

    expect(sandbox.created).toBe(false)
    expect(execs).toHaveLength(1)
    expect(execs[0]?.cmd).toEqual(['sh', '-c', 'docker compose up -d'])
  })

  it('refuses a failed setup loudly rather than serving a container without its toolchain', async () => {
    const { engine: fake } = fakeEngine({ exitCodes: [1] })

    const attempt = ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, setup: 'apt-get install -y git' },
    })

    await expect(attempt).rejects.toThrow(/setup failed/)
  })

  it('reports a failed start as a warning, not a death', async () => {
    const { engine: fake } = fakeEngine({ exitCodes: [1] })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, start: 'docker compose up -d' },
    })

    expect(sandbox.warnings.some((one) => one.includes('start'))).toBe(true)
  })

  it('refuses changed mounts on an existing container — a new container is needed, never a recreate', async () => {
    const { engine: fake } = fakeEngine({
      existing: { id: 'kept-1', state: 'running', mounts: systemMounts },
    })

    const attempt = ensureSandbox({
      engine: fake,
      config: {
        ...FAKE_CONFIG,
        mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
      },
    })

    await expect(attempt).rejects.toThrow(/new container/)
  })

  it('refuses mounts removed since creation the same way', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/Developer/shared-lib',
            destination: '/Users/operator/Developer/shared-lib',
            readOnly: true,
          },
        ],
      },
    })

    await expect(ensureSandbox({ engine: fake, config: FAKE_CONFIG })).rejects.toThrow(
      /new container/,
    )
  })

  it('reuses a container whose mounts still match the config', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/Developer/shared-lib',
            destination: '/Users/operator/Developer/shared-lib',
            readOnly: true,
          },
        ],
      },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: {
        ...FAKE_CONFIG,
        mounts: [{ path: '/Users/operator/Developer/shared-lib', mode: EMountMode.ReadOnly }],
      },
    })

    expect(sandbox.created).toBe(false)
    expect(sandbox.id).toBe('kept-1')
  })

  it('treats atlas home subtrees as system mounts, so they never trigger a drift refusal', async () => {
    const { engine: fake } = fakeEngine({
      existing: {
        id: 'kept-1',
        state: 'running',
        mounts: [
          ...systemMounts,
          {
            source: '/Users/operator/.atlas/memory',
            destination: '/Users/operator/.atlas/memory',
            readOnly: true,
          },
        ],
      },
    })

    const sandbox = await ensureSandbox({
      engine: fake,
      config: { ...FAKE_CONFIG, atlasHomeSubtrees: ['/Users/operator/.atlas/memory'] },
    })

    expect(sandbox.created).toBe(false)
    expect(sandbox.id).toBe('kept-1')
  })
})
