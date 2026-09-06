import { afterEach, describe, expect, it } from 'bun:test'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerEngine } from '../engine'
import { stopSandbox, sweepSandboxes } from '../lifecycle'
import { dockerUnavailableReason } from './live-docker'
import {
  DEFAULT_SANDBOX_IMAGE,
  ensureSandbox,
  worktreeLabel,
  type SandboxConfig,
} from '../sandbox'

const SOCKET = process.env.ATLAS_DOCKER_SOCKET ?? '/var/run/docker.sock'
const describeDocker = (await dockerUnavailableReason(SOCKET)) === undefined ? describe : describe.skip

const engine = new DockerEngine({ socketPath: SOCKET })
const PREFIX = 'atlas-dev-lifecycle'

const sweepDaemon = async (): Promise<void> => {
  const stale = await engine.listContainers({
    labels: { [worktreeLabel(PREFIX)]: undefined },
    all: true,
  })
  for (const container of stale) await engine.removeContainer({ id: container.id })
}

describeDocker('lifecycle against a live daemon', () => {
  afterEach(sweepDaemon)

  let worktree = ''

  const liveConfig = (): SandboxConfig => ({
    image: DEFAULT_SANDBOX_IMAGE,
    worktree,
    uid: process.getuid?.() ?? 501,
    gid: process.getgid?.() ?? 20,
    home: '/Users/operator',
    limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
    dockerSocket: SOCKET,
    labelPrefix: PREFIX,
  })

  const runExec = async (args: {
    containerId: string
    cmd: readonly string[]
  }): Promise<string> => {
    const exec = await engine.createExec({
      containerId: args.containerId,
      cmd: args.cmd,
      cwd: '/',
      env: {},
    })
    const stream = await engine.startExec({ execId: exec.id })
    const text = await new Response(stream).text()
    for (;;) {
      const state = await engine.inspectExec({ execId: exec.id })
      if (!state.running) return text
      await Bun.sleep(50)
    }
  }

  it('stops a running sandbox, which ensure then restarts with its filesystem intact', async () => {
    worktree = await mkdtemp(join(tmpdir(), 'atlas-dev-lifecycle-'))
    try {
      const created = await ensureSandbox({ engine, config: liveConfig() })
      await runExec({
        containerId: created.id,
        cmd: ['sh', '-c', 'echo warm > /tmp/atlas-dev-warm-marker'],
      })

      expect(await stopSandbox({ engine, prefix: PREFIX, worktree })).toBe(true)
      expect((await engine.inspectContainer({ id: created.id })).state.running).toBe(false)

      const resumed = await ensureSandbox({ engine, config: liveConfig() })
      expect(resumed.id).toBe(created.id)
      expect(resumed.created).toBe(false)

      const marker = await runExec({
        containerId: created.id,
        cmd: ['cat', '/tmp/atlas-dev-warm-marker'],
      })
      expect(marker).toContain('warm')
    } finally {
      await rm(worktree, { recursive: true, force: true })
    }
  }, 120_000)

  it('sweeps a container whose worktree is gone and keeps one whose worktree exists', async () => {
    worktree = await mkdtemp(join(tmpdir(), 'atlas-dev-lifecycle-'))
    const gone = await mkdtemp(join(tmpdir(), 'atlas-dev-lifecycle-gone-'))

    try {
      const kept = await ensureSandbox({ engine, config: liveConfig() })
      const orphaned = await ensureSandbox({
        engine,
        config: { ...liveConfig(), worktree: gone },
      })
      await rm(gone, { recursive: true, force: true })

      const removed = await sweepSandboxes({ engine, prefix: PREFIX, worktrees: [worktree] })

      expect(removed).toEqual([gone])
      const remaining = await engine.listContainers({
        labels: { [worktreeLabel(PREFIX)]: undefined },
        all: true,
      })
      expect(remaining.map((one) => one.id)).toEqual([kept.id])
      expect(remaining[0]?.id).not.toBe(orphaned.id)
    } finally {
      await rm(worktree, { recursive: true, force: true })
      await rm(gone, { recursive: true, force: true })
    }
  }, 120_000)
})
