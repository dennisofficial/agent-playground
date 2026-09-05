import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { atlasHomeFrom, isUnderPath } from '@dltech/atlas-core'

import {
  DEFAULT_DOCKER_SOCKET,
  DEFAULT_SANDBOX_IMAGE,
  type SandboxConfig,
  type SandboxLimits,
} from './sandbox'
import { EImageKind, type ContainerResolution } from '../image/resolve'
import type { Mount } from '../image/mounts'

export type HostSandboxEnvironment = {
  uid: number
  gid: number
  home: string
  sshAuthSock?: string | undefined
  gpgAgentExtraSocket?: string | undefined
  gitconfigPath?: string | undefined
}

const gpgAgentExtraSocket = (): string | undefined => {
  const gpgconf = Bun.which('gpgconf')
  if (gpgconf === null) return undefined

  const probed = Bun.spawnSync([gpgconf, '--list-dirs', 'agent-extra-socket'])
  if (!probed.success) return undefined

  const path = new TextDecoder().decode(probed.stdout).trim()
  return path !== '' && existsSync(path) ? path : undefined
}

const operatorIds = (): { uid: number; gid: number } => {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error('container mode needs a platform that has uid and gid')
  }
  return { uid: process.getuid(), gid: process.getgid() }
}

const containerHomeMatchingHostPath = (env: Record<string, string | undefined>): string =>
  env.HOME ?? homedir()

export function hostSandboxEnvironment(args?: {
  env?: Record<string, string | undefined>
}): HostSandboxEnvironment {
  const env = args?.env ?? process.env
  const home = containerHomeMatchingHostPath(env)

  const sshAuthSock = env.SSH_AUTH_SOCK
  const gitconfigPath = join(home, '.gitconfig')
  const { uid, gid } = operatorIds()

  return {
    uid,
    gid,
    home,
    sshAuthSock:
      sshAuthSock !== undefined && existsSync(sshAuthSock) ? sshAuthSock : undefined,
    gpgAgentExtraSocket: gpgAgentExtraSocket(),
    gitconfigPath: existsSync(gitconfigPath) ? gitconfigPath : undefined,
  }
}

const imageOf = (resolution: ContainerResolution): string => {
  if (resolution.image.kind === EImageKind.Image) return resolution.image.reference
  throw new Error(
    `${resolution.image.path} asks for an image build, which is not wired up — name an image in .atlas/container.json instead`,
  )
}

// The atlas home root holds auth.json, the vault key and harness.db, which never enter a
// container — so the container gets these four fixed subtrees, one bind each, and the root
// cannot be reached by widening the list.
export const ATLAS_HOME_MOUNTED_SUBTREES = ['memory', 'skills', 'agents', 'projects'] as const

export function mountedAtlasHomeSubtrees(args: {
  worktree: string
  declared?: readonly Mount[] | undefined
  atlasHome?: string | undefined
}): readonly string[] {
  const atlasHome = args.atlasHome ?? atlasHomeFrom({ env: process.env, home: homedir() })
  const covered = [args.worktree, ...(args.declared ?? []).map((mount) => mount.path)]

  return ATLAS_HOME_MOUNTED_SUBTREES.map((name) => join(atlasHome, name)).filter(
    (subtree) =>
      existsSync(subtree) &&
      !covered.some((root) => isUnderPath({ directory: root, path: subtree })),
  )
}

export function sandboxConfigFromHost(args: {
  worktree: string
  limits: SandboxLimits
  image?: string | undefined
  resolution?: ContainerResolution | undefined
  labelPrefix?: string | undefined
  atlasHomeSubtrees?: readonly string[] | undefined
}): SandboxConfig {
  const host = hostSandboxEnvironment()

  return {
    image:
      args.resolution !== undefined
        ? imageOf(args.resolution)
        : (args.image ?? DEFAULT_SANDBOX_IMAGE),
    worktree: args.worktree,
    uid: host.uid,
    gid: host.gid,
    home: host.home,
    limits: args.limits,
    dockerSocket: process.env.ATLAS_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET,
    labelPrefix: args.labelPrefix,
    sshAuthSock: host.sshAuthSock,
    gpgAgentExtraSocket: host.gpgAgentExtraSocket,
    gitconfigPath: host.gitconfigPath,
    setup: args.resolution?.setup,
    start: args.resolution?.start,
    mounts: args.resolution?.mounts,
    atlasHomeSubtrees:
      args.atlasHomeSubtrees ??
      mountedAtlasHomeSubtrees({ worktree: args.worktree, declared: args.resolution?.mounts }),
  }
}
