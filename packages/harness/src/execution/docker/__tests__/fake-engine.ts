import type { SandboxConfig, SandboxEngine } from '../sandbox'

export type RecordedExec = { cmd: readonly string[]; user: string | undefined }

export const FAKE_CONFIG: SandboxConfig = {
  image: 'node:22-slim',
  worktree: '/Users/operator/Developer/project',
  uid: 501,
  gid: 20,
  home: '/Users/operator',
  limits: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
  dockerSocket: '/var/run/docker.sock',
}

export const systemMounts = [
  { source: FAKE_CONFIG.worktree, destination: FAKE_CONFIG.worktree, readOnly: false },
  { source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
]

export const fakeEngine = (args?: {
  existing?: {
    id: string
    state: string
    image?: string
    mounts: readonly { source: string; destination: string; readOnly: boolean }[]
  }
  exitCodes?: number[]
}): {
  engine: SandboxEngine
  execs: RecordedExec[]
  builds: string[]
  creates: string[]
} => {
  const execs: RecordedExec[] = []
  const builds: string[] = []
  const creates: string[] = []
  const exitCodes = [...(args?.exitCodes ?? [])]

  const engine: SandboxEngine = {
    listContainers: async () =>
      args?.existing === undefined
        ? []
        : [
            {
              id: args.existing.id,
              name: 'atlas-deadbeef1234',
              state: args.existing.state,
              labels: {},
            },
          ],
    inspectContainer: async () => ({
      id: args?.existing?.id ?? 'created-1',
      name: 'atlas-deadbeef1234',
      state: { running: args?.existing?.state === 'running' },
      config: { labels: {}, env: [], image: args?.existing?.image ?? FAKE_CONFIG.image },
      mounts: args?.existing?.mounts ?? [],
      ports: [],
      hostConfig: { nanoCpus: 0, memoryBytes: 0 },
    }),
    info: async () => ({ cpus: 64, memoryBytes: 1024 ** 4 }),
    createContainer: async (createArgs) => {
      creates.push(createArgs.body.Image)
      return { id: 'created-1', warnings: [] }
    },
    startContainer: async () => undefined,
    createExec: async (execArgs) => {
      execs.push({ cmd: execArgs.cmd, user: execArgs.user })
      return { id: `exec-${execs.length}` }
    },
    startExec: async () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    inspectExec: async () => ({ running: false, exitCode: exitCodes.shift() ?? 0 }),
    images: {
      listImages: async () => [],
      buildImage: async (build) => {
        builds.push(build.tag)
      },
    },
  }

  return { engine, execs, builds, creates }
}
