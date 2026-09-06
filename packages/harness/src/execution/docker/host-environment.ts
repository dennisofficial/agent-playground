import { existsSync, statSync } from 'node:fs'
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
import { mountsWithGitMetadata } from './git-metadata-mounts'

export type HostSandboxEnvironment = {
  uid: number
  gid: number
  home: string
  sshAuthSock?: string | undefined
  sshKnownHostsPath?: string | undefined
  gpgAgentExtraSocket?: string | undefined
  gpgPubringPath?: string | undefined
  gitconfigPath?: string | undefined
}

const gpgAgentExtraSocket = (env: Record<string, string | undefined>): string | undefined => {
  const gpgconf = Bun.which('gpgconf', env.PATH === undefined ? undefined : { PATH: env.PATH })
  if (gpgconf === null) return undefined

  const probed = Bun.spawnSync([gpgconf, '--list-dirs', 'agent-extra-socket'], { env })
  if (!probed.success) return undefined

  const path = new TextDecoder().decode(probed.stdout).trim()
  return path !== '' && statSync(path, { throwIfNoEntry: false })?.isSocket() ? path : undefined
}

const existingFilePath = (path: string): string | undefined =>
  statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined

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
  const sshKnownHostsPath = join(home, '.ssh', 'known_hosts')
  const gitconfigPath = join(home, '.gitconfig')
  const gpgPubringPath = join(env.GNUPGHOME || join(home, '.gnupg'), 'pubring.kbx')
  const { uid, gid } = operatorIds()
  const gpgAgentSocket = gpgAgentExtraSocket(env)

  return {
    uid,
    gid,
    home,
    sshAuthSock:
      sshAuthSock !== undefined && existsSync(sshAuthSock) ? sshAuthSock : undefined,
    sshKnownHostsPath: existingFilePath(sshKnownHostsPath),
    gpgAgentExtraSocket: gpgAgentSocket,
    gpgPubringPath: gpgAgentSocket !== undefined ? existingFilePath(gpgPubringPath) : undefined,
    gitconfigPath: existsSync(gitconfigPath) ? gitconfigPath : undefined,
  }
}

const imageOf = (resolution: ContainerResolution): string => {
  if (resolution.image.kind === EImageKind.Image) return resolution.image.reference
  throw new Error(
    `${resolution.image.path} asks for an image build, which is not wired up — name an image in .atlas/container.json instead`,
  )
}

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
    sshKnownHostsPath: host.sshKnownHostsPath,
    gpgAgentExtraSocket: host.gpgAgentExtraSocket,
    gpgPubringPath: host.gpgPubringPath,
    gitconfigPath: host.gitconfigPath,
    setup: args.resolution?.setup,
    start: args.resolution?.start,
    mounts: mountsWithGitMetadata({ worktree: args.worktree, declared: args.resolution?.mounts ?? [] }),
    atlasHomeSubtrees:
      args.atlasHomeSubtrees ??
      mountedAtlasHomeSubtrees({ worktree: args.worktree, declared: args.resolution?.mounts }),
  }
}
