import { afterEach, describe, expect, it } from 'bun:test'

import { DockerEngine, EngineRequestFailed } from '../engine'
import { dockerUnavailableReason } from './live-docker'

const SOCKET = '/var/run/docker.sock'
const describeDocker = (await dockerUnavailableReason(SOCKET)) === undefined ? describe : describe.skip

const engine = new DockerEngine({ socketPath: SOCKET })
const LABEL = { 'atlas-dev.spec': 'engine' }

const sweep = async (): Promise<void> => {
  const stale = await engine.listContainers({ labels: LABEL, all: true })
  for (const container of stale) await engine.removeContainer({ id: container.id })
}

describeDocker('DockerEngine over the unix socket', () => {
  afterEach(sweep)

  it('reports the daemon capacity', async () => {
    const info = await engine.info()

    expect(info.cpus).toBeGreaterThan(0)
    expect(info.memoryBytes).toBeGreaterThan(0)
  })

  it('creates, starts, lists by label, inspects, stops and removes a container', async () => {
    const created = await engine.createContainer({
      name: 'atlas-dev-engine-lifecycle',
      body: {
        Image: 'node:22-slim',
        Cmd: ['sleep', 'infinity'],
        Labels: LABEL,
      },
    })
    expect(created.id).toHaveLength(64)

    expect(await engine.listContainers({ labels: LABEL })).toHaveLength(0)

    await engine.startContainer({ id: created.id })

    const listed = await engine.listContainers({ labels: LABEL })
    expect(listed.map((container) => container.id)).toEqual([created.id])
    expect(listed[0]?.labels['atlas-dev.spec']).toBe('engine')

    const running = await engine.inspectContainer({ id: created.id })
    expect(running.state.running).toBe(true)

    await engine.stopContainer({ id: created.id })
    expect((await engine.inspectContainer({ id: created.id })).state.running).toBe(false)

    await engine.removeContainer({ id: created.id })
    expect(await engine.listContainers({ labels: LABEL, all: true })).toHaveLength(0)
  })

  it('runs an exec and reports its exit code', async () => {
    const created = await engine.createContainer({
      name: 'atlas-dev-engine-exec',
      body: { Image: 'node:22-slim', Cmd: ['sleep', 'infinity'], Labels: LABEL },
    })
    await engine.startContainer({ id: created.id })

    const exec = await engine.createExec({
      containerId: created.id,
      cmd: ['sh', '-c', 'echo out; echo err >&2; exit 3'],
      cwd: '/tmp',
      env: {},
    })
    const framed = await engine.startExec({ execId: exec.id })
    const bytes = new Uint8Array(await new Response(framed).arrayBuffer())
    expect(bytes.length).toBeGreaterThan(16)

    const state = await engine.inspectExec({ execId: exec.id })
    expect(state.running).toBe(false)
    expect(state.exitCode).toBe(3)
  })

  it('streams a long-running exec rather than buffering it', async () => {
    const created = await engine.createContainer({
      name: 'atlas-dev-engine-streaming',
      body: { Image: 'node:22-slim', Cmd: ['sleep', 'infinity'], Labels: LABEL },
    })
    await engine.startContainer({ id: created.id })

    const exec = await engine.createExec({
      containerId: created.id,
      cmd: ['sh', '-c', 'echo first; sleep 1; echo second'],
      cwd: '/tmp',
      env: {},
    })
    const framed = await engine.startExec({ execId: exec.id })
    const reader = framed.getReader()

    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(Buffer.from(first.value ?? new Uint8Array()).toString('utf8')).toContain('first')

    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    expect((await engine.inspectExec({ execId: exec.id })).exitCode).toBe(0)
  })

  it('fails with the daemon message on a missing container', async () => {
    const failure = await engine
      .inspectContainer({ id: 'atlas-dev-no-such-container' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(EngineRequestFailed)
    expect((failure as EngineRequestFailed).status).toBe(404)
    expect((failure as EngineRequestFailed).message).toContain('atlas-dev-no-such-container')
  })
})
