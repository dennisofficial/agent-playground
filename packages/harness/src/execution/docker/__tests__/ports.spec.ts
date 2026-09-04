import { afterEach, describe, expect, it } from 'bun:test'

import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerProcessPort } from '../docker-process'
import { DockerEngine } from '../engine'
import {
  blockRefusal,
  derivedHostPort,
  EXPOSED_PORT_BLOCK,
  EXPOSED_PORT_COUNT,
  EXPOSED_PORT_FIRST,
  portInBlock,
  publishPlanFor,
} from '../ports'
import {
  DEFAULT_SANDBOX_IMAGE,
  sandboxCreateBody,
  worktreeLabel,
  type SandboxConfig,
} from '../sandbox'

const WORKTREE = '/Users/operator/Developer/project/.atlas/worktrees/feature'

describe('derivedHostPort', () => {
  it('is a pure function of the worktree key and the container port', () => {
    const first = derivedHostPort({ worktree: WORKTREE, containerPort: 3000 })

    expect(first).toBe(derivedHostPort({ worktree: WORKTREE, containerPort: 3000 }))
    expect(first).toBeGreaterThanOrEqual(20_000)
    expect(first).toBeLessThan(49_152)
  })

  it('gives two worktrees different host ports for the same container port', () => {
    const one = derivedHostPort({ worktree: '/work/one', containerPort: 3000 })
    const two = derivedHostPort({ worktree: '/work/two', containerPort: 3000 })

    expect(one).not.toBe(two)
  })

  it('spreads the block across different host ports within one worktree', () => {
    const ports = EXPOSED_PORT_BLOCK.map((containerPort) =>
      derivedHostPort({ worktree: WORKTREE, containerPort }),
    )

    expect(new Set(ports).size).toBe(EXPOSED_PORT_BLOCK.length)
  })
})

describe('the published block', () => {
  it('holds four consecutive container ports from 3000', () => {
    expect(EXPOSED_PORT_COUNT).toBe(4)
    expect(EXPOSED_PORT_BLOCK).toEqual([3000, 3001, 3002, 3003])
  })

  it('admits block members and nothing else', () => {
    expect(portInBlock(EXPOSED_PORT_FIRST)).toBe(true)
    expect(portInBlock(EXPOSED_PORT_FIRST + EXPOSED_PORT_COUNT - 1)).toBe(true)
    expect(portInBlock(EXPOSED_PORT_FIRST - 1)).toBe(false)
    expect(portInBlock(8080)).toBe(false)
  })

  it('refuses a port outside the block by naming the port, the block and the constraint', () => {
    const reason = blockRefusal({ containerPort: 8080 })

    expect(reason).toContain('8080')
    expect(reason).toContain('3000')
    expect(reason).toContain('3003')
    expect(reason).toContain('created')
  })
})

describe('publishPlanFor', () => {
  it('binds every block port to a distinct host port', () => {
    const plan = publishPlanFor({ worktree: WORKTREE })

    expect(plan.map((one) => one.containerPort)).toEqual([...EXPOSED_PORT_BLOCK])
    expect(new Set(plan.map((one) => one.hostPort)).size).toBe(EXPOSED_PORT_BLOCK.length)
  })

  it('uses the derived host port while it is free', () => {
    const plan = publishPlanFor({ worktree: WORKTREE })

    expect(plan[0]?.hostPort).toBe(derivedHostPort({ worktree: WORKTREE, containerPort: 3000 }))
  })

  it('falls back to an ephemeral host port when the derived one is taken', () => {
    const worktree = '/work/taken-fallback'
    const derived = derivedHostPort({ worktree, containerPort: 3000 })
    const occupant = Bun.listen({
      hostname: '127.0.0.1',
      port: derived,
      socket: { data() {} },
    })

    try {
      const plan = publishPlanFor({ worktree })
      const first = plan[0]

      expect(first?.containerPort).toBe(3000)
      expect(first?.hostPort).not.toBe(derived)

      const probe = Bun.listen({
        hostname: '127.0.0.1',
        port: first?.hostPort ?? 0,
        socket: { data() {} },
      })
      probe.stop(true)
    } finally {
      occupant.stop(true)
    }
  })
})

describe('sandboxCreateBody publishing', () => {
  const config: SandboxConfig = {
    image: DEFAULT_SANDBOX_IMAGE,
    worktree: WORKTREE,
    uid: 501,
    gid: 20,
    home: '/Users/operator',
    limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
    dockerSocket: '/var/run/docker.sock',
  }

  it('publishes the whole block on 127.0.0.1, because publishing only exists at create', () => {
    const body = sandboxCreateBody(config)

    expect(Object.keys(body.ExposedPorts ?? {}).sort()).toEqual(
      EXPOSED_PORT_BLOCK.map((port) => `${port}/tcp`).sort(),
    )

    const bindings = body.HostConfig?.PortBindings ?? {}
    for (const { containerPort, hostPort } of publishPlanFor({ worktree: WORKTREE })) {
      expect(bindings[`${containerPort}/tcp`]).toEqual([
        { HostIp: '127.0.0.1', HostPort: String(hostPort) },
      ])
    }
  })
})

const SOCKET = '/var/run/docker.sock'
const describeDocker = existsSync(SOCKET) ? describe : describe.skip
const engine = new DockerEngine({ socketPath: SOCKET })
const PREFIX = 'atlas-dev-ports'

const sweep = async (): Promise<void> => {
  const stale = await engine.listContainers({
    labels: { [worktreeLabel(PREFIX)]: undefined },
    all: true,
  })
  for (const container of stale) await engine.removeContainer({ id: container.id })
}

describeDocker('published ports against a live daemon', () => {
  afterEach(sweep)

  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const configFor = (root: string): SandboxConfig => ({
    image: DEFAULT_SANDBOX_IMAGE,
    worktree: root,
    uid: process.getuid?.() ?? 501,
    gid: process.getgid?.() ?? 20,
    home: '/Users/operator',
    limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
    dockerSocket: SOCKET,
    labelPrefix: PREFIX,
  })

  const openPort = async (args: { containerPort?: number; root?: string } = {}) => {
    const root = args.root ?? (await realpath(await mkdtemp(join(tmpdir(), 'atlas-ports-'))))
    roots.push(root)
    const processes = new DockerProcessPort({
      engine,
      sandbox: configFor(root),
      dockerCli: null,
    })
    return {
      root,
      outcome: await processes.exposePort({ containerPort: args.containerPort ?? 3000 }),
    }
  }

  it('gives two sandboxes exposing container port 3000 different host ports, and neither fails', async () => {
    const one = await openPort()
    const two = await openPort()
    if (!one.outcome.ok) throw new Error(one.outcome.reason)
    if (!two.outcome.ok) throw new Error(two.outcome.reason)

    expect(one.outcome.exposure.containerPort).toBe(3000)
    expect(two.outcome.exposure.containerPort).toBe(3000)
    expect(one.outcome.exposure.hostPort).not.toBe(two.outcome.exposure.hostPort)
    expect(one.outcome.exposure.hostPort).toBe(
      derivedHostPort({ worktree: one.root, containerPort: 3000 }),
    )
    expect(one.outcome.exposure.url).toBe(`http://localhost:${one.outcome.exposure.hostPort}`)
  }, 60_000)

  it('keeps the same host port across a container stop and start', async () => {
    const first = await openPort()
    if (!first.outcome.ok) throw new Error(first.outcome.reason)

    const found = await engine.listContainers({
      labels: { [worktreeLabel(PREFIX)]: first.root },
      all: true,
    })
    const id = found[0]?.id ?? ''
    await engine.stopContainer({ id })

    const again = await openPort({ root: first.root })
    if (!again.outcome.ok) throw new Error(again.outcome.reason)

    expect(again.outcome.exposure.hostPort).toBe(first.outcome.exposure.hostPort)
    expect((await engine.inspectContainer({ id })).state.running).toBe(true)
  }, 60_000)

  it('refuses a port outside the block without creating anything', async () => {
    const { outcome } = await openPort({ containerPort: 8080 })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('8080')
    expect(
      await engine.listContainers({ labels: { [worktreeLabel(PREFIX)]: undefined }, all: true }),
    ).toHaveLength(0)
  })

  it('answers a request from the host at the published URL', async () => {
    const { root, outcome } = await openPort()
    if (!outcome.ok) throw new Error(outcome.reason)

    const found = await engine.listContainers({ labels: { [worktreeLabel(PREFIX)]: root } })
    const exec = await engine.createExec({
      containerId: found[0]?.id ?? '',
      cmd: [
        'node',
        '-e',
        "require('http').createServer((req, res) => res.end('hello-from-sandbox')).listen(3000)",
      ],
      cwd: '/',
      env: {},
    })
    await engine.startExec({ execId: exec.id, detach: true })

    let body = ''
    for (let attempt = 0; attempt < 100 && body === ''; attempt += 1) {
      body = await fetch(outcome.exposure.url)
        .then((response) => response.text())
        .catch(() => '')
      if (body === '') await Bun.sleep(100)
    }

    expect(body).toBe('hello-from-sandbox')
  }, 60_000)
})
