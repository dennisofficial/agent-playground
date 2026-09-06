import {
  ProcessPort,
  type PortExposureOutcome,
  type ProcessHandle,
  type SpawnCommand,
} from '@dltech/atlas-core'

import { SIGKILL_GRACE_MS } from '../local-process'
import { demuxExecStream } from './frames'
import { execEnvFor } from './exec-environment'
import { EngineRequestFailed, type ContainerDetails, type DockerEngine } from './engine'
import { blockRefusal, portInBlock } from './ports'
import {
  DEFAULT_LABEL_PREFIX,
  ensureSandbox,
  worktreeLabel,
  type Sandbox,
  type SandboxConfig,
} from './sandbox'
import { ESandboxState, type SandboxStatusListener } from './status'

type RunningExec = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  signal: (signal: 'TERM' | 'KILL') => Promise<void>
}

const bridge = (
  source: Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      source
        .then(async (stream) => {
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) {
              controller.close()
              return
            }
            if (value !== undefined) controller.enqueue(value)
          }
        })
        .catch((error: unknown) => controller.error(error))
    },
  })

const containerStopped = (error: unknown): boolean =>
  error instanceof EngineRequestFailed &&
  error.status === 409 &&
  error.message.includes('is not running')

export class DockerProcessPort implements ProcessPort {
  private readonly engine: DockerEngine
  private readonly sandboxConfig: SandboxConfig
  private readonly dockerCli: string | null
  private readonly onStatus: SandboxStatusListener | undefined
  private sandboxPromise: Promise<Sandbox> | undefined
  private imageEnv: readonly string[] | undefined
  private collected: string[] = []

  constructor(args: {
    engine: DockerEngine
    sandbox: SandboxConfig
    dockerCli?: string | null
    onStatus?: SandboxStatusListener | undefined
  }) {
    this.engine = args.engine
    this.sandboxConfig = args.sandbox
    this.dockerCli = args.dockerCli === undefined ? Bun.which('docker') : args.dockerCli
    this.onStatus = args.onStatus
  }

  get warnings(): readonly string[] {
    return this.collected
  }

  sandboxStopped(): void {
    this.sandboxPromise = undefined
    this.imageEnv = undefined
  }

  spawn(args: SpawnCommand): ProcessHandle {
    const setup = this.startExec(args)
    let fired = false

    return {
      stdout: bridge(setup.then((exec) => exec.stdout)),
      stderr: bridge(setup.then((exec) => exec.stderr)),
      exited: setup.then((exec) => exec.exited),
      terminate: () => {
        if (fired) return
        fired = true
        void setup.then((exec) => exec.signal('TERM')).catch(() => undefined)
        setTimeout(() => {
          void setup.then((exec) => exec.signal('KILL')).catch(() => undefined)
        }, SIGKILL_GRACE_MS).unref()
      },
    }
  }

  async exposePort(args: { containerPort: number }): Promise<PortExposureOutcome> {
    if (!portInBlock(args.containerPort)) {
      return { ok: false, reason: blockRefusal({ containerPort: args.containerPort }) }
    }

    const sandbox = await this.ensure()
    const details = await this.engine.inspectContainer({ id: sandbox.id })
    const bound = details.ports.find((one) => one.containerPort === args.containerPort)
    if (bound === undefined) {
      return {
        ok: false,
        reason: `this sandbox was created without published ports, and Docker cannot publish one onto a running container; remove the sandbox container so the next command creates it with the block`,
      }
    }

    return {
      ok: true,
      exposure: {
        containerPort: args.containerPort,
        hostPort: bound.hostPort,
        url: `http://localhost:${bound.hostPort}`,
      },
    }
  }

  which(args: { command: string }): string | null {
    if (this.dockerCli === null) return null

    const prefix = this.sandboxConfig.labelPrefix ?? DEFAULT_LABEL_PREFIX
    const listed = Bun.spawnSync([
      this.dockerCli,
      'container',
      'ls',
      '-q',
      '--filter',
      `label=${worktreeLabel(prefix)}=${this.sandboxConfig.worktree}`,
    ])
    const id = new TextDecoder().decode(listed.stdout).trim()
    if (id === '') return null

    const probed = Bun.spawnSync([
      this.dockerCli,
      'exec',
      id,
      'sh',
      '-c',
      'command -v "$1"',
      'sh',
      args.command,
    ])
    if (!probed.success) return null

    const found = new TextDecoder().decode(probed.stdout).trim()
    return found === '' ? null : found
  }

  private ensure(): Promise<Sandbox> {
    if (this.sandboxPromise === undefined) {
      this.onStatus?.({ state: ESandboxState.Starting })
      this.sandboxPromise = this.ensureTracked()
    }
    return this.sandboxPromise
  }

  private async ensureTracked(): Promise<Sandbox> {
    try {
      const { sandbox, details } = await this.ensureRunning()
      this.collected.push(...sandbox.warnings)
      this.imageEnv = details.config.env
      this.onStatus?.({ state: ESandboxState.Running, ports: details.ports })
      return sandbox
    } catch (error) {
      this.onStatus?.({
        state: ESandboxState.Failed,
        reason: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async ensureRunning(): Promise<{ sandbox: Sandbox; details: ContainerDetails }> {
    const ensured = await this.ensureInspected()
    if (ensured.details.state.running) return ensured

    return await this.ensureInspected()
  }

  private async ensureInspected(): Promise<{ sandbox: Sandbox; details: ContainerDetails }> {
    const sandbox = await ensureSandbox({
      engine: this.engine,
      config: this.sandboxConfig,
    })
    return { sandbox, details: await this.engine.inspectContainer({ id: sandbox.id }) }
  }

  private async startExec(args: SpawnCommand): Promise<RunningExec> {
    try {
      return await this.execIn({ sandbox: await this.ensure(), command: args })
    } catch (error) {
      if (!containerStopped(error)) throw error

      this.onStatus?.({ state: ESandboxState.Stopped })
      this.sandboxStopped()
      return await this.execIn({ sandbox: await this.ensure(), command: args })
    }
  }

  private async execIn(args: { sandbox: Sandbox; command: SpawnCommand }): Promise<RunningExec> {
    const { sandbox, command } = args
    this.imageEnv ??= (await this.engine.inspectContainer({ id: sandbox.id })).config.env

    const pidfile = `/tmp/atlas-exec-${crypto.randomUUID()}.pid`
    const exec = await this.engine.createExec({
      containerId: sandbox.id,
      cmd: ['sh', '-c', `printf %s $$ > ${pidfile}; exec "$@"`, 'sh', ...command.cmd],
      cwd: command.cwd,
      env:
        command.env === undefined
          ? {}
          : execEnvFor({
              requested: command.env,
              imageEnv: this.imageEnv,
              home: this.sandboxConfig.home,
            }),
    })
    const demuxed = demuxExecStream({
      stream: await this.engine.startExec({ execId: exec.id }),
    })

    const exited = (async (): Promise<number> => {
      await demuxed.done
      for (;;) {
        const state = await this.engine.inspectExec({ execId: exec.id })
        if (!state.running && state.exitCode !== null) return state.exitCode
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })()

    return {
      stdout: demuxed.stdout,
      stderr: demuxed.stderr,
      exited,
      signal: async (signal) => {
        await this.signalGroup({ containerId: sandbox.id, pidfile, signal })
      },
    }
  }

  private async signalGroup(args: {
    containerId: string
    pidfile: string
    signal: 'TERM' | 'KILL'
  }): Promise<void> {
    const script = [
      `i=0; while [ $i -lt 50 ] && [ ! -f ${args.pidfile} ]; do i=$((i+1)); sleep 0.1; done`,
      `kill -${args.signal} -$(cat ${args.pidfile}) 2>/dev/null || true`,
    ].join('; ')

    const exec = await this.engine.createExec({
      containerId: args.containerId,
      cmd: ['sh', '-c', script],
      cwd: '/',
      env: {},
    })
    await this.engine.startExec({ execId: exec.id, detach: true })
  }
}
