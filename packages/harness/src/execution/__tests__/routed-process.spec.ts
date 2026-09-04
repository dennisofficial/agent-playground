import { afterAll, describe, expect, it } from 'bun:test'

import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EExecutionLocation,
  toThreadId,
  type PortExposureOutcome,
  type ProcessHandle,
  type ProcessPort,
  type SpawnCommand,
  type ThreadId,
} from '@dltech/atlas-core'

import { DockerProcessPort } from '../docker/docker-process'
import { DockerEngine } from '../docker/engine'
import { worktreeLabel, type SandboxConfig } from '../docker/sandbox'
import { LocalProcessPort } from '../local-process'
import { RoutedProcessPort } from '../routed-process'

const HOST_THREAD = toThreadId('host-thread')
const DOCKER_THREAD = toThreadId('docker-thread')

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const idleHandle = (): ProcessHandle => ({
  stdout: streamOf(''),
  stderr: streamOf(''),
  exited: Promise.resolve(0),
  terminate: () => undefined,
})

class RecordingProcesses implements ProcessPort {
  readonly spawned: SpawnCommand[] = []
  readonly probed: { command: string; threadId?: ThreadId | undefined }[] = []
  readonly exposed: { containerPort: number; threadId?: ThreadId | undefined }[] = []

  constructor(private readonly answer: string | null = null) {}

  spawn(args: SpawnCommand): ProcessHandle {
    this.spawned.push(args)
    return idleHandle()
  }

  which(args: { command: string; threadId?: ThreadId | undefined }): string | null {
    this.probed.push(args)
    return this.answer
  }
}

class ExposingProcesses extends RecordingProcesses {
  async exposePort(args: {
    containerPort: number
    threadId?: ThreadId | undefined
  }): Promise<PortExposureOutcome> {
    this.exposed.push(args)
    return {
      ok: true,
      exposure: {
        containerPort: args.containerPort,
        hostPort: args.containerPort + 20_000,
        url: `http://localhost:${args.containerPort + 20_000}`,
      },
    }
  }
}

const locationOf = (threadId: ThreadId | undefined): EExecutionLocation =>
  threadId === DOCKER_THREAD ? EExecutionLocation.Docker : EExecutionLocation.Host

const routed = (args: { local: ProcessPort; docker: ProcessPort }): RoutedProcessPort =>
  new RoutedProcessPort({ local: args.local, docker: () => args.docker, locationOf })

describe('RoutedProcessPort', () => {
  it('sends a host thread to the local port', () => {
    const local = new RecordingProcesses()
    const docker = new RecordingProcesses()
    const port = routed({ local, docker })

    port.spawn({ cmd: ['true'], cwd: '/work', threadId: HOST_THREAD })

    expect(local.spawned).toHaveLength(1)
    expect(docker.spawned).toHaveLength(0)
  })

  it('sends a docker thread to the docker port with the thread still on the command', () => {
    const local = new RecordingProcesses()
    const docker = new RecordingProcesses()
    const port = routed({ local, docker })

    port.spawn({ cmd: ['true'], cwd: '/work', threadId: DOCKER_THREAD })

    expect(docker.spawned).toHaveLength(1)
    expect(docker.spawned[0]?.threadId).toBe(DOCKER_THREAD)
    expect(local.spawned).toHaveLength(0)
  })

  it('asks the lookup what to do with a spawn that names no thread', () => {
    const local = new RecordingProcesses()
    const docker = new RecordingProcesses()
    const port = routed({ local, docker })

    port.spawn({ cmd: ['true'], cwd: '/work' })

    expect(local.spawned).toHaveLength(1)
    expect(docker.spawned).toHaveLength(0)
  })

  it('routes which() with the same thread so grep probes where it will run', () => {
    const local = new RecordingProcesses('/bin/rg')
    const docker = new RecordingProcesses('/usr/bin/rg')
    const port = routed({ local, docker })

    expect(port.which({ command: 'rg', threadId: DOCKER_THREAD })).toBe('/usr/bin/rg')
    expect(port.which({ command: 'rg', threadId: HOST_THREAD })).toBe('/bin/rg')
    expect(docker.probed[0]?.threadId).toBe(DOCKER_THREAD)
  })

  it('routes exposePort with the thread and refuses when the chosen port cannot expose', async () => {
    const local = new RecordingProcesses()
    const docker = new ExposingProcesses()
    const port = routed({ local, docker })

    const exposed = await port.exposePort({ containerPort: 3000, threadId: DOCKER_THREAD })
    expect(exposed.ok).toBe(true)
    expect(docker.exposed[0]?.threadId).toBe(DOCKER_THREAD)

    const refused = await port.exposePort({ containerPort: 3000, threadId: HOST_THREAD })
    expect(refused.ok).toBe(false)
  })
})

const SOCKET = '/var/run/docker.sock'
const DOCKER_AVAILABLE = existsSync(SOCKET)
const describeDocker = DOCKER_AVAILABLE ? describe : describe.skip

const engine = new DockerEngine({ socketPath: SOCKET })
const PREFIX = 'atlas-dev'

const worktree = await realpath(await mkdtemp(join(tmpdir(), 'atlas-dev-routed-')))

afterAll(async () => {
  if (DOCKER_AVAILABLE) {
    const stale = await engine.listContainers({
      labels: { [worktreeLabel(PREFIX)]: worktree },
      all: true,
    })
    for (const container of stale) await engine.removeContainer({ id: container.id })
  }
  await rm(worktree, { recursive: true, force: true })
})

const sandboxConfig = (): SandboxConfig => ({
  image: 'node:22-slim',
  worktree,
  uid: 501,
  gid: 20,
  home: '/Users/operator',
  limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
  dockerSocket: SOCKET,
  labelPrefix: PREFIX,
})

const textOf = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  await new Response(stream).text()

const runToEnd = async (args: {
  port: ProcessPort
  command: string
  threadId: ThreadId
}): Promise<{ stdout: string; exitCode: number }> => {
  const handle = args.port.spawn({
    cmd: ['bash', '-c', args.command],
    cwd: worktree,
    threadId: args.threadId,
  })
  const [stdout, exitCode] = await Promise.all([textOf(handle.stdout), handle.exited])
  return { stdout, exitCode }
}

describeDocker('RoutedProcessPort against a live daemon', () => {
  it("lands a containerized thread's bash inside the sandbox and a host thread's on the host", async () => {
    const port = new RoutedProcessPort({
      local: new LocalProcessPort(),
      docker: () => new DockerProcessPort({ engine, sandbox: sandboxConfig() }),
      locationOf,
    })

    const inside = await runToEnd({
      port,
      command: 'echo "compose=${COMPOSE_PROJECT_NAME:-none}"',
      threadId: DOCKER_THREAD,
    })
    expect(inside.exitCode).toBe(0)
    expect(inside.stdout).toContain(`compose=atlas-dev-`)
    expect(inside.stdout).not.toContain('compose=none')

    const outside = await runToEnd({
      port,
      command: 'echo "compose=${COMPOSE_PROJECT_NAME:-none}"',
      threadId: HOST_THREAD,
    })
    expect(outside.exitCode).toBe(0)
    expect(outside.stdout).toContain('compose=none')
  }, 60_000)
})
