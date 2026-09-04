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

const GH_VIEW_FIELDS = 'number,state,isDraft,url,statusCheckRollup,title'

export const GH_PULL_REQUEST_ARGV = ['gh', 'pr', 'view', '--json', GH_VIEW_FIELDS] as const

const linkedArgv = (args: { repo: string; number: number }): readonly string[] => [
  'gh',
  'pr',
  'view',
  String(args.number),
  '--repo',
  args.repo,
  '--json',
  GH_VIEW_FIELDS,
]

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
 * A pill is decoration: losing one must never take a turn, or opening a thread, down. Nothing
 * throws out of `read` or `readLinked`.
 */
export class GhPullRequestPort extends PullRequestPort {
  readonly pushes = false

  private readonly run: CommandRunner
  private installed = true

  constructor(args?: { run?: CommandRunner }) {
    super()
    this.run = args?.run ?? spawnCommand
  }

  /**
   * Never `--repo` and never a branch argument: `gh pr view` with no argument resolves the pull
   * request for the checkout's current branch through its remote-tracking config, which is what
   * makes it right in a fork whose head repository is not `origin`. The probed branch keys the
   * cache, not the call.
   */
  async read({ checkout }: { checkout: RepositoryCheckout }): Promise<PullRequestReading> {
    if (checkout.forge === EForge.Other) return unavailable(false)

    return this.ask({ argv: GH_PULL_REQUEST_ARGV, cwd: checkout.directory })
  }

  /**
   * `gh pr view <number> --repo HOST/OWNER/REPO` needs no checkout at all, which is the point: a
   * linked pull request's worktree may be gone. `Bun.spawn` still wants a directory to start in,
   * so the process's own stands in — gh never consults it once `--repo` is given.
   */
  async readLinked({
    repo,
    number,
  }: {
    repo: string
    number: number
  }): Promise<PullRequestReading> {
    return this.ask({ argv: linkedArgv({ repo, number }), cwd: process.cwd() })
  }

  private async ask(request: {
    argv: readonly string[]
    cwd: string
  }): Promise<PullRequestReading> {
    if (!this.installed) return unavailable(false)

    const run = await this.run({
      argv: request.argv,
      cwd: request.cwd,
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
