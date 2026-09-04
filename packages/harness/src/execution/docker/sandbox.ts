import { createHash } from 'node:crypto'

import { mountBind, type Mount } from '../image/mounts'
import { SandboxMountsChanged, mountsDrift, systemMountDestinations } from './mount-drift'
import { publishPlanFor } from './ports'
import { runSandboxScripts } from './sandbox-scripts'
import type { ContainerSummary, CreateContainerBody, DockerEngine } from './engine'

export const DEFAULT_LABEL_PREFIX = 'atlas'

export const DEFAULT_SANDBOX_IMAGE = 'node:22-slim'

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'

export const CONTAINER_GNUPG_HOME = '/run/atlas/gnupg'

export type SandboxEngine = Pick<
  DockerEngine,
  | 'createContainer'
  | 'createExec'
  | 'info'
  | 'inspectContainer'
  | 'inspectExec'
  | 'listContainers'
  | 'startContainer'
  | 'startExec'
>

export type SandboxLimits = {
  cpus: number
  memoryBytes: number
}

export type SandboxConfig = {
  image: string
  worktree: string
  uid: number
  gid: number
  home: string
  limits: SandboxLimits
  dockerSocket: string
  labelPrefix?: string | undefined
  sshAuthSock?: string | undefined
  gpgAgentExtraSocket?: string | undefined
  gitconfigPath?: string | undefined
  setup?: string | undefined
  start?: string | undefined
  mounts?: readonly Mount[] | undefined
}

export type Sandbox = {
  id: string
  name: string
  created: boolean
  warnings: readonly string[]
}

export const worktreeLabel = (prefix: string): string => `${prefix}.worktree`

export const sandboxNameFor = (args: { prefix: string; worktree: string }): string =>
  `${args.prefix}-${createHash('sha256').update(args.worktree).digest('hex').slice(0, 12)}`

export function sandboxCreateBody(config: SandboxConfig): CreateContainerBody {
  const prefix = config.labelPrefix ?? DEFAULT_LABEL_PREFIX
  const published = publishPlanFor({ worktree: config.worktree })
  const binds: string[] = [
    `${config.worktree}:${config.worktree}`,
    `${config.dockerSocket}:${config.dockerSocket}`,
  ]
  const env: string[] = [`HOME=${config.home}`, `COMPOSE_PROJECT_NAME=${sandboxNameFor({ prefix, worktree: config.worktree })}`]

  if (config.sshAuthSock !== undefined) {
    binds.push(`${config.sshAuthSock}:${config.sshAuthSock}`)
    env.push(`SSH_AUTH_SOCK=${config.sshAuthSock}`)
  }
  if (config.gitconfigPath !== undefined) {
    binds.push(`${config.gitconfigPath}:${config.gitconfigPath}:ro`)
  }
  for (const mount of config.mounts ?? []) binds.push(mountBind(mount))

  // git honours GIT_CONFIG_COUNT/KEY_n/VALUE_n pairs (since git 2.31) above every config file,
  // which is what lets them override the read-only bind-mounted ~/.gitconfig: the operator's Mac
  // pins gpg.program to /usr/local/MacGPG2/bin/gpg2, which does not exist in the container, and
  // the bind-mounted worktree presents an owner that git's safe.directory check refuses.
  env.push(
    'GIT_CONFIG_COUNT=2',
    'GIT_CONFIG_KEY_0=gpg.program',
    'GIT_CONFIG_VALUE_0=gpg',
    'GIT_CONFIG_KEY_1=safe.directory',
    `GIT_CONFIG_VALUE_1=${config.worktree}`,
  )
  if (config.gpgAgentExtraSocket !== undefined) {
    // gpg derives its agent socket from GNUPGHOME and offers no path override, so the forwarded
    // agent-extra-socket has to land at the standard agent path of whichever home gpg is given.
    // https://gnupg.org/documentation/manuals/gnupg/Agent-Options.html#index-extra_002dsocket
    binds.push(`${config.gpgAgentExtraSocket}:${CONTAINER_GNUPG_HOME}/S.gpg-agent`)
    env.push(`GNUPGHOME=${CONTAINER_GNUPG_HOME}`)
  }

  return {
    Image: config.image,
    Cmd: ['sleep', 'infinity'],
    User: `${config.uid}:${config.gid}`,
    WorkingDir: config.worktree,
    Env: env,
    Labels: { [worktreeLabel(prefix)]: config.worktree },
    ExposedPorts: Object.fromEntries(published.map((one) => [`${one.containerPort}/tcp`, {}])),
    HostConfig: {
      Binds: binds,
      NanoCpus: config.limits.cpus * 1e9,
      Memory: config.limits.memoryBytes,
      PortBindings: Object.fromEntries(
        published.map((one) => [
          `${one.containerPort}/tcp`,
          [{ HostIp: '127.0.0.1', HostPort: String(one.hostPort) }],
        ]),
      ),
    },
  }
}

export async function findSandbox(args: {
  engine: SandboxEngine
  prefix: string
  worktree: string
}): Promise<ContainerSummary | undefined> {
  const matches = await args.engine.listContainers({
    labels: { [worktreeLabel(args.prefix)]: args.worktree },
    all: true,
  })
  return matches[0]
}

export async function oversubscriptionWarnings(args: {
  engine: SandboxEngine
  prefix: string
  adding: SandboxLimits
}): Promise<string[]> {
  const [info, running] = await Promise.all([
    args.engine.info(),
    args.engine.listContainers({ labels: { [worktreeLabel(args.prefix)]: undefined } }),
  ])
  const details = await Promise.all(
    running.map((container) => args.engine.inspectContainer({ id: container.id })),
  )

  const memoryBytes =
    details.reduce((total, one) => total + one.hostConfig.memoryBytes, 0) + args.adding.memoryBytes
  const nanoCpus =
    details.reduce((total, one) => total + one.hostConfig.nanoCpus, 0) + args.adding.cpus * 1e9

  const warnings: string[] = []
  if (memoryBytes > info.memoryBytes) {
    warnings.push(
      `the running sandboxes plus this one are limited to ${Math.round(memoryBytes / 1024 ** 3)} GB of memory against the daemon's ${Math.round(info.memoryBytes / 1024 ** 3)} GB — the OOM killer will arbitrate, not the limit`,
    )
  }
  if (nanoCpus > info.cpus * 1e9) {
    warnings.push(
      `the running sandboxes plus this one are limited to ${Math.round(nanoCpus / 1e9)} cpus against the daemon's ${info.cpus} — they will throttle each other, not queue`,
    )
  }
  return warnings
}

const identitySocketPaths = (config: SandboxConfig): readonly string[] =>
  [
    config.sshAuthSock,
    config.gpgAgentExtraSocket === undefined
      ? undefined
      : `${CONTAINER_GNUPG_HOME}/S.gpg-agent`,
  ].filter((path): path is string => path !== undefined)

/**
 * Docker Desktop proxies a bind-mounted macOS unix socket into the VM as root:root 0660 whatever
 * the host permissions are, and creates the socket's mount-parent directory root-owned, so the
 * operator-uid execs cannot connect (nor write a keyring beside the socket) until a root exec
 * relaxes both. Verified against Docker Desktop 4.89 / Engine 29.7.2 on macOS 26.
 */
const relaxIdentitySockets = async (args: {
  engine: SandboxEngine
  containerId: string
  config: SandboxConfig
}): Promise<void> => {
  const paths = identitySocketPaths(args.config)
  const commands: string[] = []
  if (args.config.gpgAgentExtraSocket !== undefined) {
    commands.push(
      `chown ${args.config.uid}:${args.config.gid} ${CONTAINER_GNUPG_HOME} && chmod 700 ${CONTAINER_GNUPG_HOME}`,
    )
  }
  if (paths.length > 0) commands.push(`chmod 666 ${paths.join(' ')}`)
  if (commands.length === 0) return

  const exec = await args.engine.createExec({
    containerId: args.containerId,
    cmd: ['sh', '-c', commands.join('; ')],
    cwd: '/',
    env: {},
    user: '0',
  })
  await args.engine.startExec({ execId: exec.id, detach: true })
}

export async function ensureSandbox(args: {
  engine: SandboxEngine
  config: SandboxConfig
}): Promise<Sandbox> {
  const prefix = args.config.labelPrefix ?? DEFAULT_LABEL_PREFIX
  const name = sandboxNameFor({ prefix, worktree: args.config.worktree })

  const existing = await findSandbox({ engine: args.engine, prefix, worktree: args.config.worktree })
  if (existing !== undefined) {
    const details = await args.engine.inspectContainer({ id: existing.id })
    if (
      mountsDrift({
        requested: args.config.mounts ?? [],
        actual: details.mounts,
        system: systemMountDestinations(args.config),
      })
    ) {
      throw new SandboxMountsChanged({ name })
    }

    if (existing.state !== 'running') await args.engine.startContainer({ id: existing.id })
    await relaxIdentitySockets({
      engine: args.engine,
      containerId: existing.id,
      config: args.config,
    })
    const warnings = await runSandboxScripts({
      engine: args.engine,
      containerId: existing.id,
      name,
      config: args.config,
      created: false,
    })
    return { id: existing.id, name, created: false, warnings }
  }

  const warnings = await oversubscriptionWarnings({
    engine: args.engine,
    prefix,
    adding: args.config.limits,
  })
  const created = await args.engine.createContainer({ name, body: sandboxCreateBody(args.config) })
  await args.engine.startContainer({ id: created.id })
  await relaxIdentitySockets({
    engine: args.engine,
    containerId: created.id,
    config: args.config,
  })
  const scriptWarnings = await runSandboxScripts({
    engine: args.engine,
    containerId: created.id,
    name,
    config: args.config,
    created: true,
  })

  return {
    id: created.id,
    name,
    created: true,
    warnings: [...warnings, ...created.warnings, ...scriptWarnings],
  }
}
