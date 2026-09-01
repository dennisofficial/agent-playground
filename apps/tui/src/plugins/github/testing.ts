import {
  EChecksState,
  EForge,
  EPullRequestLookup,
  EPullRequestState,
  NO_CHECKS,
  PullRequestPort,
  type ChecksTally,
  type PullRequest,
  type PullRequestReading,
  type RepositoryCheckout,
} from './pure'
import { ESpawnFailure, SPAWN_FAILED, type CommandRun, type CommandRunner } from './run-command'

export type CommandCall = { argv: readonly string[]; cwd: string; timeoutMs: number }

export type RecordingRunner = CommandRunner & { readonly calls: readonly CommandCall[] }

const OK: CommandRun = { code: 0, stdout: '', stderr: '', failure: null }

export const recordingRunner = (answer: (call: CommandCall) => CommandRun): RecordingRunner => {
  const calls: CommandCall[] = []
  const runner: RecordingRunner = Object.assign(
    async (call: CommandCall): Promise<CommandRun> => {
      calls.push(call)
      return answer(call)
    },
    { calls },
  )

  return runner
}

export const ghAnswering = (...runs: readonly Partial<CommandRun>[]): RecordingRunner => {
  let handed = 0

  return recordingRunner(() => {
    const run = runs[Math.min(handed, runs.length - 1)]
    handed += 1
    return { ...OK, ...run }
  })
}

export const ghSpawnFailure = (args: {
  failure: ESpawnFailure
  message?: string
}): Partial<CommandRun> => ({
  code: SPAWN_FAILED,
  stderr: args.message ?? args.failure,
  failure: args.failure,
})

export type ScriptedPullRequests = PullRequestPort & { readonly asked: readonly string[] }

export const pullRequestsAnswering = (
  ...readings: readonly PullRequestReading[]
): ScriptedPullRequests =>
  new (class extends PullRequestPort {
    readonly pushes = false
    readonly asked: string[] = []
    private handed = 0

    async read({ checkout }: { checkout: RepositoryCheckout }): Promise<PullRequestReading> {
      this.asked.push(checkout.directory)
      const reading = readings[Math.min(this.handed, readings.length - 1)]
      this.handed += 1
      return reading ?? { lookup: EPullRequestLookup.Unavailable, retryable: true }
    }
  })()

export const aCheckout = (args?: {
  directory?: string
  branch?: string
  owner?: string
  repo?: string
  forge?: EForge
}): RepositoryCheckout => ({
  directory: args?.directory ?? '/work/atlas',
  branch: args?.branch ?? 'main',
  forge: args?.forge ?? EForge.GitHub,
  remote: {
    host: 'github.com',
    owner: args?.owner ?? 'dennisofficial',
    repo: args?.repo ?? 'atlas',
  },
})

export type PullRequestShape = { number?: number; checks?: EChecksState; tally?: ChecksTally }

export const aPullRequest = (args?: PullRequestShape): PullRequest => ({
  number: args?.number ?? 42,
  title: 'a change',
  url: `https://github.com/dennisofficial/atlas/pull/${args?.number ?? 42}`,
  state: EPullRequestState.Open,
  checks: args?.checks ?? EChecksState.Passing,
  tally: args?.tally ?? NO_CHECKS,
})

export const wasFound = (args?: PullRequestShape): PullRequestReading => ({
  lookup: EPullRequestLookup.Found,
  pullRequest: aPullRequest(args),
})

export const WAS_ABSENT: PullRequestReading = { lookup: EPullRequestLookup.Absent }

export const wasUnavailable = (retryable: boolean): PullRequestReading => ({
  lookup: EPullRequestLookup.Unavailable,
  retryable,
})

export type StoppedClock = { now: () => number; advance: (ms: number) => void }

export const stoppedClock = (start: number): StoppedClock => {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

export const countingPort = (args: { pushes: boolean; reading: PullRequestReading }) =>
  new (class extends PullRequestPort {
    readonly pushes = args.pushes
    calls = 0
    async read(): Promise<PullRequestReading> {
      this.calls += 1
      return args.reading
    }
  })()

export const rejectingPort = () =>
  new (class extends PullRequestPort {
    readonly pushes = false
    calls = 0
    async read(): Promise<PullRequestReading> {
      this.calls += 1
      throw new Error('the socket went away')
    }
  })()

export const suspendedPort = () => {
  const gate: { settle: ((reading: PullRequestReading) => void) | null } = { settle: null }
  const port = new (class extends PullRequestPort {
    readonly pushes = false
    calls = 0
    async read(): Promise<PullRequestReading> {
      this.calls += 1
      return new Promise<PullRequestReading>((resolve) => {
        gate.settle = resolve
      })
    }
  })()

  return { port, gate }
}
