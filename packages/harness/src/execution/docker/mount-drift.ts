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

export const systemMountDestinations = (config: SandboxConfig): ReadonlySet<string> =>
  new Set(
    [
      config.worktree,
      config.dockerSocket,
      config.sshAuthSock,
      config.gitconfigPath,
      config.gpgAgentExtraSocket === undefined
        ? undefined
        : `${CONTAINER_GNUPG_HOME}/S.gpg-agent`,
      ...(config.atlasHomeSubtrees ?? []),
    ].filter((path): path is string => path !== undefined),
  )

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
      .map((mount) => [mount.destination, mount.readOnly]),
  )

  if (wanted.size !== present.size) return true
  for (const [path, readOnly] of wanted) {
    if (present.get(path) !== readOnly) return true
  }
  return false
}
