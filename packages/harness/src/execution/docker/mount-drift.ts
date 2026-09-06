import { EMountMode, type Mount } from '../image/mounts'
import { CONTAINER_GNUPG_HOME, type SandboxConfig } from './sandbox'
import type { ContainerMount } from './engine'

export class SandboxMountsChanged extends Error {
  constructor(args: { name: string }) {
    super(
      `the declared mounts changed since ${args.name} was created, and Docker cannot add a bind to an existing container — this worktree needs a new container: remove ${args.name} and start again`,
    )
    this.name = 'SandboxMountsChanged'
  }
}

export class SandboxImageChanged extends Error {
  constructor(args: { name: string; image: string }) {
    super(
      `the image for ${args.name} changed to ${args.image} since the container was created, and Docker cannot swap an existing container's image — this worktree needs a new container: remove ${args.name} and start again`,
    )
    this.name = 'SandboxImageChanged'
  }
}

export const systemMountDestinations = (config: SandboxConfig): ReadonlySet<string> =>
  new Set(
    [
      config.worktree,
      config.dockerSocket,
      config.sshAuthSock,
      config.sshKnownHostsPath,
      config.gitconfigPath,
      config.gpgAgentExtraSocket === undefined
        ? undefined
        : `${CONTAINER_GNUPG_HOME}/S.gpg-agent`,
      config.gpgAgentExtraSocket === undefined || config.gpgPubringPath === undefined
        ? undefined
        : `${CONTAINER_GNUPG_HOME}/pubring.kbx`,
      ...(config.atlasHomeSubtrees ?? []),
    ].filter((path): path is string => path !== undefined),
  )

export const publicIdentityMountsDrift = (args: {
  config: SandboxConfig
  actual: readonly ContainerMount[]
}): boolean => {
  const expected: ContainerMount[] = []
  const { config } = args
  if (config.sshKnownHostsPath !== undefined) {
    expected.push({ source: config.sshKnownHostsPath, destination: config.sshKnownHostsPath, readOnly: true })
  }
  if (config.gpgAgentExtraSocket !== undefined && config.gpgPubringPath !== undefined) {
    expected.push({ source: config.gpgPubringPath, destination: `${CONTAINER_GNUPG_HOME}/pubring.kbx`, readOnly: true })
  }
  return expected.some((wanted) => !args.actual.some((mount) =>
    mount.source === wanted.source && mount.destination === wanted.destination && mount.readOnly,
  ))
}

export const mountsDrift = (args: {
  requested: readonly Mount[]
  actual: readonly ContainerMount[]
  system: ReadonlySet<string>
}): boolean => {
  const wanted = new Map(
    args.requested.map((mount) => [mount.path, mount.mode === EMountMode.ReadOnly]),
  )
  const present = new Map(
    args.actual
      .filter((mount) => !args.system.has(mount.destination))
      .map((mount) => [mount.destination, mount]),
  )

  if (wanted.size !== present.size) return true
  for (const [path, readOnly] of wanted) {
    const mount = present.get(path)
    if (mount?.source !== path || mount.readOnly !== readOnly) return true
  }
  return false
}
