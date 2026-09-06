import { afterEach, describe, expect, it } from 'bun:test'

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DockerEngine } from '../engine'
import { runSandboxScript } from '../sandbox-scripts'
import { dockerUnavailableReason } from './live-docker'
import {
  ensureSandbox,
  findSandbox,
  oversubscriptionWarnings,
  worktreeLabel,
  type SandboxConfig,
} from '../sandbox'

const SOCKET = '/var/run/docker.sock'
const describeDocker = (await dockerUnavailableReason(SOCKET)) === undefined ? describe : describe.skip

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
