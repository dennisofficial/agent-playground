import {
  EExecutionLocation,
  ProcessPort,
  type PortExposureOutcome,
  type ProcessHandle,
  type SpawnCommand,
  type ThreadId,
} from '@dltech/atlas-core'

export class RoutedProcessPort implements ProcessPort {
  private readonly local: ProcessPort
  private readonly dockerFor: () => ProcessPort
  private readonly locationOf: (threadId: ThreadId | undefined) => EExecutionLocation
  private docker: ProcessPort | undefined

  constructor(args: {
    local: ProcessPort
    docker: () => ProcessPort
    locationOf: (threadId: ThreadId | undefined) => EExecutionLocation
  }) {
    this.local = args.local
    this.dockerFor = args.docker
    this.locationOf = args.locationOf
  }

  spawn(args: SpawnCommand): ProcessHandle {
    return this.portFor(args.threadId).spawn(args)
  }

  which(args: { command: string; threadId?: ThreadId | undefined }): string | null {
    return this.portFor(args.threadId).which(args)
  }

  async exposePort(args: {
    containerPort: number
    threadId?: ThreadId | undefined
  }): Promise<PortExposureOutcome> {
    const port = this.portFor(args.threadId)
    if (port.exposePort === undefined) {
      return { ok: false, reason: 'the port this thread runs on cannot expose ports' }
    }

    return await port.exposePort(args)
  }

  private portFor(threadId: ThreadId | undefined): ProcessPort {
    if (this.locationOf(threadId) !== EExecutionLocation.Docker) return this.local

    this.docker ??= this.dockerFor()
    return this.docker
  }
}
