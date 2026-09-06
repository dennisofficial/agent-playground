import { consumeDaemonProgress } from './image-pull'
import { parseBoundPorts, type BoundPort, type PortBinding } from './ports'
import { asLabels, asNumber, asRecord, asString, raw, request, EngineRequestFailed } from './engine-http'
import { DockerImages } from './engine-images'

export { EngineRequestFailed } from './engine-http'
export type { ImageSummary } from './engine-images'

export type EngineInfo = {
  cpus: number
  memoryBytes: number
}

export type ContainerSummary = {
  id: string
  name: string
  state: string
  labels: Record<string, string>
}

export type ContainerMount = {
  source: string
  destination: string
  readOnly: boolean
}

export type ContainerDetails = {
  id: string
  name: string
  state: { running: boolean }
  config: { labels: Record<string, string>; env: readonly string[]; image: string }
  mounts: readonly ContainerMount[]
  ports: readonly BoundPort[]
  hostConfig: { nanoCpus: number; memoryBytes: number }
}

export type CreateContainerBody = {
  Image: string
  Cmd: readonly string[]
  User?: string
  WorkingDir?: string
  Env?: readonly string[]
  Labels?: Record<string, string>
  ExposedPorts?: Record<string, Record<string, never>>
  HostConfig?: {
    Binds?: readonly string[]
    NanoCpus?: number
    Memory?: number
    PortBindings?: Record<string, readonly PortBinding[]>
  }
}

export type ExecState = {
  running: boolean
  exitCode: number | null
}

export class DockerEngine {
  private readonly socketPath: string
  readonly images: DockerImages

  constructor(args: { socketPath: string }) {
    this.socketPath = args.socketPath
    this.images = new DockerImages({ socketPath: args.socketPath })
  }

  async info(): Promise<EngineInfo> {
    const body = asRecord(await this.request({ method: 'GET', path: '/info' }))
    return { cpus: asNumber(body.NCPU), memoryBytes: asNumber(body.MemTotal) }
  }

  async listContainers(args: {
    labels: Record<string, string | undefined>
    all?: boolean
  }): Promise<ContainerSummary[]> {
    const filters = JSON.stringify({
      label: Object.entries(args.labels).map(([key, value]) =>
        value === undefined ? key : `${key}=${value}`,
      ),
    })
    const body = await this.request({
      method: 'GET',
      path: '/containers/json',
      query: { all: args.all === true ? '1' : '0', filters },
    })
    if (!Array.isArray(body)) throw new Error('the daemon answered out of shape')

    return body.map((entry) => {
      const record = asRecord(entry)
      return {
        id: asString(record.Id),
        name: asString((record.Names as string[] | undefined)?.[0] ?? ''),
        state: asString(record.State),
        labels: asLabels(record.Labels),
      }
    })
  }

  async inspectContainer(args: { id: string }): Promise<ContainerDetails> {
    const body = asRecord(await this.request({ method: 'GET', path: `/containers/${args.id}/json` }))
    const state = asRecord(body.State)
    const config = asRecord(body.Config)
    const hostConfig = asRecord(body.HostConfig)
    const network = asRecord(body.NetworkSettings ?? {})
    const mounts = Array.isArray(body.Mounts) ? body.Mounts : []

    return {
      id: asString(body.Id),
      name: asString(body.Name),
      state: { running: state.Running === true },
      config: {
        labels: asLabels(config.Labels),
        env: Array.isArray(config.Env) ? config.Env.filter((one) => typeof one === 'string') : [],
        image: asString(config.Image),
      },
      mounts: mounts.map((entry) => {
        const mount = asRecord(entry)
        return {
          source: asString(mount.Source),
          destination: asString(mount.Destination),
          readOnly: mount.RW === false,
        }
      }),
      ports: parseBoundPorts(network.Ports),
      hostConfig: {
        nanoCpus: typeof hostConfig.NanoCpus === 'number' ? hostConfig.NanoCpus : 0,
        memoryBytes: typeof hostConfig.Memory === 'number' ? hostConfig.Memory : 0,
      },
    }
  }

  async createContainer(args: {
    name: string
    body: CreateContainerBody
  }): Promise<{ id: string; warnings: readonly string[] }> {
    const create = () => this.request({
      method: 'POST',
      path: '/containers/create',
      query: { name: args.name },
      body: args.body,
    })
    const body = asRecord(
      await create().catch(async (error: unknown) => {
        if (
          !(error instanceof EngineRequestFailed) ||
          error.status !== 404 ||
          error.message !== `No such image: ${args.body.Image}`
        ) {
          throw error
        }
        const response = await this.raw({
          method: 'POST',
          path: '/images/create',
          query: { fromImage: args.body.Image },
        })
        await consumeDaemonProgress({ response, what: `Pulling ${args.body.Image}` })
        return create()
      }),
    )
    const warnings = Array.isArray(body.Warnings)
      ? body.Warnings.filter((one): one is string => typeof one === 'string')
      : []
    return { id: asString(body.Id), warnings }
  }

  async startContainer(args: { id: string }): Promise<void> {
    await this.request({ method: 'POST', path: `/containers/${args.id}/start` })
  }

  async stopContainer(args: { id: string }): Promise<void> {
    await this.request({ method: 'POST', path: `/containers/${args.id}/stop` })
  }

  async removeContainer(args: { id: string }): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `/containers/${args.id}`,
      query: { force: '1', v: '1' },
    })
  }

  async createExec(args: {
    containerId: string
    cmd: readonly string[]
    cwd: string
    env: Record<string, string>
    user?: string
  }): Promise<{ id: string }> {
    const body = asRecord(
      await this.request({
        method: 'POST',
        path: `/containers/${args.containerId}/exec`,
        body: {
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: args.cwd,
          Env: Object.entries(args.env).map(([key, value]) => `${key}=${value}`),
          Cmd: [...args.cmd],
          ...(args.user === undefined ? {} : { User: args.user }),
        },
      }),
    )
    return { id: asString(body.Id) }
  }

  async startExec(args: { execId: string; detach?: boolean }): Promise<ReadableStream<Uint8Array>> {
    const response = await this.raw({
      method: 'POST',
      path: `/exec/${args.execId}/start`,
      body: { Detach: args.detach === true, Tty: false },
    })
    if (args.detach === true) {
      await response.arrayBuffer()
      return new ReadableStream({ start: (controller) => controller.close() })
    }
    if (response.body === null) throw new Error('the exec stream had no body')
    return response.body
  }

  async inspectExec(args: { execId: string }): Promise<ExecState> {
    const body = asRecord(await this.request({ method: 'GET', path: `/exec/${args.execId}/json` }))
    return {
      running: body.Running === true,
      exitCode: typeof body.ExitCode === 'number' ? body.ExitCode : null,
    }
  }

  private async request(args: {
    method: string
    path: string
    query?: Record<string, string>
    body?: unknown
  }): Promise<unknown> {
    return await request({ socketPath: this.socketPath, ...args })
  }

  private async raw(args: {
    method: string
    path: string
    query?: Record<string, string>
    body?: unknown
    tarBody?: Uint8Array<ArrayBuffer>
  }): Promise<Response> {
    return await raw({ socketPath: this.socketPath, ...args })
  }
}
