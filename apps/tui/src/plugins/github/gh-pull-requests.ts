import {
  EForge,
  EPullRequestLookup,
  PullRequestPort,
  type PullRequestReading,
  type RepositoryCheckout,
} from './pure'
import { parseGhPullRequest } from './parse-gh-pull-request'
import { ESpawnFailure, spawnCommand, type CommandRunner } from './run-command'

export const GH_TIMEOUT_MS = 10_000

export const GH_PULL_REQUEST_ARGV = [
  'gh',
  'pr',
  'view',
  '--json',
  'number,state,isDraft,url,statusCheckRollup,title',
] as const

/** `gh help exit-codes`: 0 ok, 1 error, 2 cancelled, 4 authentication required. */
const GH_AUTH_REQUIRED = 4

const NO_PULL_REQUEST_STDERR = 'no pull requests found'

const unavailable = (retryable: boolean): PullRequestReading => ({
  lookup: EPullRequestLookup.Unavailable,
  retryable,
})

const ABSENT: PullRequestReading = { lookup: EPullRequestLookup.Absent }

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * A forge that is definitely not GitHub reads as unavailable rather than absent: nobody asked, so
 * "there is no pull request" would be a claim this port cannot make, and `Absent` would also buy a
 * five-minute poll on a repository that can never answer.
 *
 * Never `--repo` and never a branch argument: `gh pr view` with no argument resolves the pull
 * request for the checkout's current branch through its remote-tracking config, which is what makes
 * it right in a fork whose head repository is not `origin`. The probed branch keys the cache, not
 * the call.
 *
 * A pill is decoration: losing one must never take a turn, or opening a thread, down. Nothing
 * throws out of `read`.
 */
export class GhPullRequestPort extends PullRequestPort {
  readonly pushes = false

  private readonly run: CommandRunner
  private installed = true

  constructor(args?: { run?: CommandRunner }) {
    super()
    this.run = args?.run ?? spawnCommand
  }

  async read({ checkout }: { checkout: RepositoryCheckout }): Promise<PullRequestReading> {
    if (!this.installed) return unavailable(false)
    if (checkout.forge === EForge.Other) return unavailable(false)

    const run = await this.run({
      argv: GH_PULL_REQUEST_ARGV,
      cwd: checkout.directory,
      timeoutMs: GH_TIMEOUT_MS,
    })

    if (run.failure !== null) {
      if (run.failure !== ESpawnFailure.BinaryMissing) return unavailable(true)

      this.installed = false
      return unavailable(false)
    }
    if (run.code === GH_AUTH_REQUIRED) return unavailable(false)
    if (run.code !== 0) {
      return run.stderr.includes(NO_PULL_REQUEST_STDERR) ? ABSENT : unavailable(true)
    }

    const pullRequest = parseGhPullRequest(jsonOf(run.stdout))
    if (pullRequest === null) return unavailable(true)

    return { lookup: EPullRequestLookup.Found, pullRequest }
  }
}
