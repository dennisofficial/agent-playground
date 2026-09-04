import {
  AfterToolHook,
  BeforeToolHook,
  DEFAULT_CONTAINER_IDLE_MINUTES,
  ESettingId,
  EShellStatus,
  ProcessPort,
  rangeValueOf,
} from '@dltech/atlas-core'
import {
  BashActivityHook,
  DockerProcessPort,
  EImageKind,
  ESandboxState,
  LocalProcessPort,
  ReclaimWorktreeSandboxHook,
  RoutedProcessPort,
  registerDisposable,
  sandboxConfigFromHost,
  startIdleStop,
  stopSandbox,
  portToken,
  resolveContainerConfig,
  ShellRegistryPort,
  type DependencyContainer,
  type DockerEngine,
  type SettingsService,
} from '@dltech/atlas-harness'

import { ENoticeTone, NOTICE_WARN_MS, notify } from '../ui/notice-store'
import type { ExecutionLocationState } from './execution-location-state'
import { createSandboxStatusState, type SandboxStatusState } from './sandbox-status-state'

/**
 * The lifecycle of the sandbox labelled for the session's worktree: noteBash feeds the idle
 * stopwatch, stop is what quitting runs after the shells have drained. Keyed to the worktree and
 * nothing else, so /new and thread switches never reach it.
 */
export type SandboxControl = {
  noteBash: () => void
  stop: () => Promise<boolean>
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The one place the execution binding is chosen: a routed port that answers each spawn, probe and
 * exposure for the thread that asked. The docker side is built on first use — a host-only session
 * never reads the container config beyond resolving it, and a thread the record does not know
 * (a sub-agent's, until issue 13) inherits the conversation on screen.
 */
export async function bindSandbox(args: {
  container: DependencyContainer
  engine: DockerEngine
  cwd: string
  settings: SettingsService
  executionLocation: ExecutionLocationState
}): Promise<{ sandbox: SandboxControl; containerStatus: SandboxStatusState }> {
  const { container, engine, cwd, settings, executionLocation } = args

  const resolution = await resolveContainerConfig({ projectDirectory: cwd })
  for (const refusal of resolution.refusals) {
    notify({
      key: `container-refusal:${refusal.file}`,
      tone: ENoticeTone.Warn,
      ttlMs: NOTICE_WARN_MS,
      text: `${refusal.file}: ${refusal.detail}`,
    })
  }

  const image =
    resolution.image.kind === EImageKind.Image ? resolution.image.reference : resolution.image.path
  const status = createSandboxStatusState({ image })

  let dockerPort: DockerProcessPort | undefined
  const docker = (): DockerProcessPort => {
    if (dockerPort !== undefined) return dockerPort

    try {
      dockerPort = new DockerProcessPort({
        engine,
        sandbox: sandboxConfigFromHost({
          worktree: cwd,
          resolution,
          limits: {
            cpus: rangeValueOf({
              resolution: settings.snapshot().resolution,
              id: ESettingId.ContainerCpus,
              fallback: 4,
            }),
            memoryBytes:
              rangeValueOf({
                resolution: settings.snapshot().resolution,
                id: ESettingId.ContainerMemory,
                fallback: 8,
              }) *
              1024 ** 3,
          },
        }),
        onStatus: (sandboxStatus) => {
          status.mark(sandboxStatus)
          if (sandboxStatus.state !== ESandboxState.Running) return

          dockerPort?.warnings.forEach((warning, at) =>
            notify({
              key: `sandbox-warning-${at}`,
              tone: ENoticeTone.Warn,
              ttlMs: NOTICE_WARN_MS,
              text: warning,
            }),
          )
        },
      })
    } catch (error) {
      status.mark({ state: ESandboxState.Failed, reason: messageOf(error) })
      throw error
    }
    return dockerPort
  }

  container.register(portToken(ProcessPort), {
    useValue: new RoutedProcessPort({
      local: new LocalProcessPort(),
      docker,
      locationOf: (threadId) =>
        (threadId === undefined ? undefined : executionLocation.of(threadId)) ??
        executionLocation.current(),
    }),
  })

  const markStopped = (): void => {
    status.mark({ state: ESandboxState.Stopped })
    dockerPort?.sandboxStopped()
  }

  const idleStop = startIdleStop({
    engine,
    worktree: cwd,
    runningShells: () =>
      container
        .resolve(portToken(ShellRegistryPort))
        .listEverywhere()
        .filter((shell) => shell.status === EShellStatus.Running).length,
    idleMinutes: () =>
      rangeValueOf({
        resolution: settings.snapshot().resolution,
        id: ESettingId.ContainerIdleMinutes,
        fallback: DEFAULT_CONTAINER_IDLE_MINUTES,
      }),
    onStopped: markStopped,
  })
  container.register(portToken(BeforeToolHook), {
    useValue: new BashActivityHook({ onBash: idleStop.noteBash }),
  })
  container.register(portToken(AfterToolHook), {
    useValue: new ReclaimWorktreeSandboxHook({ engine }),
  })
  registerDisposable({
    container,
    close: async () => idleStop.halt(),
  })

  const sandbox: SandboxControl = {
    noteBash: idleStop.noteBash,
    stop: async () => {
      const stopped = await stopSandbox({ engine, worktree: cwd })
      if (stopped) markStopped()
      return stopped
    },
  }

  return { sandbox, containerStatus: status }
}
