import { describe, expect, it } from 'bun:test'

import { DockerProcessPort } from '../docker-process'
import {
  DockerEngine,
  EngineRequestFailed,
  type ContainerDetails,
  type ContainerSummary,
  type ExecState,
} from '../engine'
import type { SandboxConfig } from '../sandbox'
import { ESandboxState, type SandboxStatus } from '../status'

const CONTAINER_ID = 'atlas-dev-stub-container'

const config = (): SandboxConfig => ({
  image: 'node:22-slim',
  worktree: '/work',
  uid: 501,
  gid: 20,
  home: '/home/operator',
  limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
  dockerSocket: '/var/run/docker.sock',
})

class StubEngine extends DockerEngine {
  running = true
  listCalls = 0
  inspectCalls = 0
  startCalls = 0
  execError: Error | null = null

  constructor() {
    super({ socketPath: '/atlas-dev-stub.sock' })
  }

  override async listContainers(): Promise<ContainerSummary[]> {
    this.listCalls += 1
    return [
      {
        id: CONTAINER_ID,
        name: 'atlas-dev-stub',
        state: this.running ? 'running' : 'exited',
        labels: {},
      },
    ]
  }

  override async inspectContainer(): Promise<ContainerDetails> {
    this.inspectCalls += 1
    return {
      id: CONTAINER_ID,
      name: 'atlas-dev-stub',
      state: { running: this.running },
      config: { labels: {}, env: ['PATH=/usr/local/bin'] },
      mounts: [],
      ports: [{ containerPort: 3000, hostPort: 20_000 }],
      hostConfig: { nanoCpus: 0, memoryBytes: 0 },
    }
  }

  override async startContainer(): Promise<void> {
    this.startCalls += 1
    this.running = true
  }

  private execSeq = 0

  override async createExec(): Promise<{ id: string }> {
    if (this.execError !== null) throw this.execError
    if (!this.running) {
      throw new EngineRequestFailed({
        status: 409,
        message: `Container ${CONTAINER_ID} is not running`,
      })
    }
    this.execSeq += 1
    return { id: `exec-${this.execSeq}` }
  }

  override async startExec(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({ start: (controller) => controller.close() })
  }

  override async inspectExec(): Promise<ExecState> {
    return { running: false, exitCode: 0 }
  }
}

const runTrue = async (port: DockerProcessPort): Promise<number> => {
  const handle = port.spawn({ cmd: ['true'], cwd: '/work' })
  return await handle.exited
}

const statesOf = (seen: readonly SandboxStatus[]): ESandboxState[] =>
  seen.map((one) => one.state)

describe('DockerProcessPort recovering a sandbox that stopped behind its back', () => {
  it('restarts the container and retries the exec once, marking stopped then running', async () => {
    const engine = new StubEngine()
    const seen: SandboxStatus[] = []
    const port = new DockerProcessPort({
      engine,
      sandbox: config(),
      dockerCli: null,
      onStatus: (status) => seen.push(status),
    })

    expect(await runTrue(port)).toBe(0)

    engine.running = false

    expect(await runTrue(port)).toBe(0)
    expect(engine.startCalls).toBe(1)
    expect(statesOf(seen)).toEqual([
      ESandboxState.Starting,
      ESandboxState.Running,
      ESandboxState.Stopped,
      ESandboxState.Starting,
      ESandboxState.Running,
    ])
  })

  it('does not retry an exec failure the daemon did not blame on a stopped container', async () => {
    const engine = new StubEngine()
    const seen: SandboxStatus[] = []
    const port = new DockerProcessPort({
      engine,
      sandbox: config(),
      dockerCli: null,
      onStatus: (status) => seen.push(status),
    })

    expect(await runTrue(port)).toBe(0)

    engine.execError = new EngineRequestFailed({ status: 500, message: 'daemon exploded' })

    await expect(runTrue(port)).rejects.toThrow('daemon exploded')
    expect(engine.startCalls).toBe(0)
    expect(engine.listCalls).toBe(1)
    expect(statesOf(seen)).toEqual([ESandboxState.Starting, ESandboxState.Running])
  })

  it('keeps the cached sandbox for a healthy container instead of re-inspecting per spawn', async () => {
    const engine = new StubEngine()
    const port = new DockerProcessPort({ engine, sandbox: config(), dockerCli: null })

    expect(await runTrue(port)).toBe(0)
    expect(await runTrue(port)).toBe(0)

    expect(engine.listCalls).toBe(1)
    expect(engine.inspectCalls).toBe(2)
  })

  it('restarts when the ensure-time inspect finds the listed container no longer running', async () => {
    const engine = new StubEngine()
    engine.running = false
    let firstList = true
    const listedAsRunning = engine.listContainers.bind(engine)
    engine.listContainers = async (): Promise<ContainerSummary[]> => {
      if (firstList) {
        firstList = false
        return [
          { id: CONTAINER_ID, name: 'atlas-dev-stub', state: 'running', labels: {} },
        ]
      }
      return await listedAsRunning()
    }

    const seen: SandboxStatus[] = []
    const port = new DockerProcessPort({
      engine,
      sandbox: config(),
      dockerCli: null,
      onStatus: (status) => seen.push(status),
    })

    expect(await runTrue(port)).toBe(0)
    expect(engine.startCalls).toBe(1)
    expect(statesOf(seen)).toEqual([ESandboxState.Starting, ESandboxState.Running])
  })
})
