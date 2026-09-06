import { join } from 'node:path'

import { EMountMode, type Mount } from '../image/mounts'
import { CONTAINER_GNUPG_HOME, type SandboxConfig } from './sandbox'
import type { ContainerDetails, ContainerMount } from './engine'

export const envDrift = (args: {
  declared: Record<string, string>
  actual: readonly string[]
}): boolean =>
  Object.entries(args.declared).some(
    ([key, value]) => !args.actual.includes(`${key}=${value}`),
  )

export const declaredMountsLabel = (prefix: string): string => `${prefix}.mounts`

export const encodeDeclaredMounts = (mounts: readonly Mount[]): string =>
  JSON.stringify(
    [...mounts]
      .map((mount) => ({ path: mount.path, readOnly: mount.mode === EMountMode.ReadOnly }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  )

export const systemMountDestinations = (config: SandboxConfig): ReadonlySet<string> =>
  new Set(
    [
      config.worktree,
      config.dockerSocket,
      config.sshAuthSock,
      join(config.home, '.ssh', 'known_hosts'),
      join(config.home, '.gitconfig'),
      `${CONTAINER_GNUPG_HOME}/S.gpg-agent`,
      `${CONTAINER_GNUPG_HOME}/pubring.kbx`,
      ...(config.atlasHomeSubtrees ?? []),
    ].filter((path): path is string => path !== undefined),
  )

const wantedIdentityMounts = (config: SandboxConfig): ContainerMount[] => {
  const wanted: ContainerMount[] = []
  if (config.sshKnownHostsPath !== undefined) {
    wanted.push({
      source: config.sshKnownHostsPath,
      destination: config.sshKnownHostsPath,
      readOnly: true,
    })
  }
  if (config.gpgAgentExtraSocket !== undefined && config.gpgPubringPath !== undefined) {
    wanted.push({
      source: config.gpgPubringPath,
      destination: `${CONTAINER_GNUPG_HOME}/pubring.kbx`,
      readOnly: true,
    })
  }
  return wanted
}

export const missingIdentityMounts = (args: {
  config: SandboxConfig
  actual: readonly ContainerMount[]
}): string[] =>
  wantedIdentityMounts(args.config)
    .filter(
      (wanted) =>
        !args.actual.some(
          (mount) =>
            mount.source === wanted.source &&
            mount.destination === wanted.destination &&
            mount.readOnly,
        ),
    )
    .map(
      (missing) =>
        `${missing.source} appeared after this container was created, so the sandbox cannot see it yet — the sandbox picks it up on its next recreate`,
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
      .map((mount) => [mount.destination, mount]),
  )

  if (wanted.size !== present.size) return true
  for (const [path, readOnly] of wanted) {
    const mount = present.get(path)
    if (mount?.source !== path || mount.readOnly !== readOnly) return true
  }
  return false
}

export function declaredMountsDrift(args: {
  config: SandboxConfig
  details: ContainerDetails
  prefix: string
}): boolean {
  const recorded = args.details.config.labels[declaredMountsLabel(args.prefix)]
  const declared = args.config.mounts ?? []
  if (recorded !== undefined) return recorded !== encodeDeclaredMounts(declared)

  return mountsDrift({
    requested: declared,
    actual: args.details.mounts,
    system: systemMountDestinations(args.config),
  })
}
