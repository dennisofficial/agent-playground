import { afterEach, describe, expect, it } from 'bun:test'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerEngine, EngineRequestFailed } from '../engine'

const IMAGE = 'registry.example:5000/team/node:22-trixie-slim'
const CREATE = {
  name: 'atlas-pull-test',
  body: { Image: IMAGE, Cmd: ['sleep', 'infinity'], User: '501:20' },
}

type RecordedRequest = { method: string; path: string; query: Record<string, string>; body: unknown }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function serveDaemon(responses: readonly Response[]) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-engine-'))
  const socketPath = join(directory, 'docker.sock')
  const requests: RecordedRequest[] = []
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const url = new URL(request.url)
      const text = await request.text()
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      })
      return responses[requests.length - 1] ?? new Response('unexpected request', { status: 500 })
    },
  })
  cleanups.push(async () => {
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  })
  return { engine: new DockerEngine({ socketPath }), requests }
}

const missingImage = (): Response =>
  Response.json({ message: `No such image: ${IMAGE}` }, { status: 404 })

const created = (): Response =>
  Response.json({ Id: 'container-id', Warnings: ['daemon warning', 42] }, { status: 201 })

describe('DockerEngine missing image recovery', () => {
  it('does not pull an image already cached by the daemon', async () => {
    const { engine, requests } = await serveDaemon([created()])

    expect(await engine.createContainer(CREATE)).toEqual({
      id: 'container-id', warnings: ['daemon warning'],
    })
    expect(requests).toHaveLength(1)
  })

  it.each([
    { status: 404, message: 'No such container: missing' },
    { status: 404, message: `No such image: ${IMAGE}-other` },
    { status: 404, message: 'No such image: unrelated:latest' },
    { status: 409, message: 'Conflict. The container name is already in use' },
    { status: 500, message: `No such image: ${IMAGE}` },
  ])('preserves unrelated create failures: %j', async (failure) => {
    const { engine, requests } = await serveDaemon([
      Response.json({ message: failure.message }, { status: failure.status }),
    ])

    const error: unknown = await engine.createContainer(CREATE).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(EngineRequestFailed)
    expect(error).toMatchObject(failure)
    expect(requests).toHaveLength(1)
  })

  it('preserves HTTP pull failures without retrying container creation', async () => {
    const { engine, requests } = await serveDaemon([
      missingImage(),
      Response.json({ message: 'registry unavailable' }, { status: 503 }),
    ])

    const error: unknown = await engine.createContainer(CREATE).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(EngineRequestFailed)
    expect(error).toMatchObject({ status: 503, message: 'registry unavailable' })
    expect(requests).toHaveLength(2)
  })

  it('does not pull again when the retried create still cannot find the image', async () => {
    const { engine, requests } = await serveDaemon([
      missingImage(), new Response('{"status":"Already exists"}\n'), missingImage(),
    ])

    const error: unknown = await engine.createContainer(CREATE).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(EngineRequestFailed)
    expect(error).toMatchObject({ status: 404, message: `No such image: ${IMAGE}` })
    expect(requests.map((request) => request.path)).toEqual([
      '/containers/create', '/images/create', '/containers/create',
    ])
  })

  it.each(['not JSON', 'null'])('rejects malformed pull progress without retrying: %s', async (output) => {
    const { engine, requests } = await serveDaemon([missingImage(), new Response(output)])

    await expect(engine.createContainer(CREATE)).rejects.toThrow()
    expect(requests).toHaveLength(2)
  })

  it('does not pull when a different API reports a missing image', async () => {
    const { engine, requests } = await serveDaemon([missingImage()])

    await expect(engine.inspectContainer({ id: 'missing' })).rejects.toThrow(`No such image: ${IMAGE}`)
    expect(requests).toHaveLength(1)
  })

  it('reads an error split across stream chunks without a final newline', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ['{"status":"Pulling"}\r\n\n{"err', 'or":"download interrupted"}']) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
      },
    })
    const { engine, requests } = await serveDaemon([missingImage(), new Response(stream)])

    await expect(engine.createContainer(CREATE)).rejects.toThrow('download interrupted')
    expect(requests).toHaveLength(2)
  })

  it.each([
    { error: 'registry access denied' },
    { errorDetail: { message: 'registry access denied' } },
  ])('rejects a successful HTTP pull containing a daemon error: %j', async (failure) => {
    const { engine, requests } = await serveDaemon([
      missingImage(),
      new Response(`{"status":"Pulling"}\n${JSON.stringify(failure)}\n`),
      created(),
    ])

    await expect(engine.createContainer(CREATE)).rejects.toThrow('registry access denied')
    expect(requests.map((request) => request.path)).toEqual(['/containers/create', '/images/create'])
  })

  it('pulls the requested image and retries the identical create request once', async () => {
    const { engine, requests } = await serveDaemon([
      missingImage(),
      new Response('{"status":"Pulling"}\n{"status":"Download complete"}\n'),
      created(),
    ])

    expect(await engine.createContainer(CREATE)).toEqual({
      id: 'container-id', warnings: ['daemon warning'],
    })
    expect(requests).toEqual([
      { method: 'POST', path: '/containers/create', query: { name: CREATE.name }, body: CREATE.body },
      { method: 'POST', path: '/images/create', query: { fromImage: IMAGE }, body: undefined },
      { method: 'POST', path: '/containers/create', query: { name: CREATE.name }, body: CREATE.body },
    ])
  })
})
