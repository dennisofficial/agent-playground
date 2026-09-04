import { describe, expect, it } from 'bun:test'

import { theme } from '../../ui/theme'
import type { ThreadRow } from '../../ui/threads-model'
import {
  checkoutKey,
  EForge,
  EPullRequestLookup,
  EPullRequestState,
  EChecksState,
  NO_CHECKS,
  PullRequestPort,
  type PullRequestReading,
  type RepositoryCheckout,
} from '../../plugins/github/pure'
import { threadChips } from '../thread-chips'

const HOME = '/repo'

const checkout = (args: { directory: string; branch: string }): RepositoryCheckout => ({
  directory: args.directory,
  branch: args.branch,
  forge: EForge.GitHub,
  remote: { host: 'github.com', owner: 'dennis', repo: 'atlas' },
})

const found = (args: { number: number; state?: EPullRequestState }): PullRequestReading => ({
  lookup: EPullRequestLookup.Found,
  pullRequest: {
    number: args.number,
    title: 'a pull request',
    url: `https://github.com/dennis/atlas/pull/${String(args.number)}`,
    state: args.state ?? EPullRequestState.Open,
    checks: EChecksState.None,
    tally: NO_CHECKS,
  },
})

class FakePullRequests extends PullRequestPort {
  readonly pushes = false
  readonly asked: string[] = []
  readonly askedLinked: string[] = []

  constructor(
    private readonly readings: Readonly<Record<string, PullRequestReading>>,
    private readonly linkedReadings: Readonly<Record<string, PullRequestReading>> = {},
  ) {
    super()
  }

  async read({ checkout: asked }: { checkout: RepositoryCheckout }): Promise<PullRequestReading> {
    this.asked.push(checkoutKey(asked))
    return this.readings[checkoutKey(asked)] ?? { lookup: EPullRequestLookup.Absent }
  }

  async readLinked(args: { repo: string; number: number }): Promise<PullRequestReading> {
    const key = `${args.repo}#${args.number}`
    this.askedLinked.push(key)
    return this.linkedReadings[key] ?? { lookup: EPullRequestLookup.Absent }
  }
}

const link = (args: { number: number; branch: string; repo?: string }) => ({
  number: args.number,
  url: `https://github.com/dennis/atlas/pull/${args.number}`,
  repo: args.repo ?? 'github.com/dennis/atlas',
  branch: args.branch,
})

const row = (args: {
  threadId: string
  worktree?: { path: string; branch: string }
  pullRequests?: readonly ReturnType<typeof link>[]
}): ThreadRow => ({
  threadId: args.threadId,
  label: args.threadId,
  titled: false,
  updatedAt: '2026-08-25T12:00:00.000Z',
  active: false,
  ...(args.worktree === undefined ? {} : { worktree: args.worktree }),
  ...(args.pullRequests === undefined ? {} : { pullRequests: args.pullRequests }),
})

const probeWith =
  (byDirectory: Readonly<Record<string, RepositoryCheckout>>, probed: string[]) =>
  async ({ directory }: { directory: string }): Promise<RepositoryCheckout | null> => {
    probed.push(directory)
    return byDirectory[directory] ?? null
  }

describe('the pills of one picker opening', () => {
  it('pins the pull request of the branch a worktree thread is standing on', async () => {
    const worktree = checkout({ directory: '/repo/.worktrees/auth', branch: 'dennis/auth' })
    const port = new FakePullRequests({ [checkoutKey(worktree)]: found({ number: 401 }) })
    const probed: string[] = []

    const chips = await threadChips({
      rows: [row({ threadId: 't1', worktree: { path: worktree.directory, branch: worktree.branch } })],
      home: HOME,
      pullRequests: port,
      probe: probeWith({ [worktree.directory]: worktree }, probed),
    })

    expect(probed).toEqual([worktree.directory])
    expect(chips.get('t1')?.map((chip) => chip.label)).toEqual(['#401'])
  })

  it('asks once for threads sharing the main tree, however many rows stand in it', async () => {
    const main = checkout({ directory: HOME, branch: 'main' })
    const port = new FakePullRequests({ [checkoutKey(main)]: found({ number: 402 }) })
    const probed: string[] = []

    const chips = await threadChips({
      rows: [row({ threadId: 't1' }), row({ threadId: 't2' })],
      home: HOME,
      pullRequests: port,
      probe: probeWith({ [HOME]: main }, probed),
    })

    expect(probed).toEqual([HOME])
    expect(port.asked).toEqual([checkoutKey(main)])
    expect(chips.get('t1')?.map((chip) => chip.label)).toEqual(['#402'])
    expect(chips.get('t2')?.map((chip) => chip.label)).toEqual(['#402'])
  })

  it('leaves a row bare when there is definitively no pull request', async () => {
    const main = checkout({ directory: HOME, branch: 'main' })
    const port = new FakePullRequests({})

    const chips = await threadChips({
      rows: [row({ threadId: 't1' })],
      home: HOME,
      pullRequests: port,
      probe: probeWith({ [HOME]: main }, []),
    })

    expect(chips.size).toBe(0)
  })

  it('leaves every row bare when the directory is not a checkout git can read', async () => {
    const port = new FakePullRequests({})

    const chips = await threadChips({
      rows: [row({ threadId: 't1' })],
      home: HOME,
      pullRequests: port,
      probe: async () => null,
    })

    expect(chips.size).toBe(0)
    expect(port.asked).toEqual([])
  })

  it('swallows a rejecting port, because a pill is decoration', async () => {
    const main = checkout({ directory: HOME, branch: 'main' })
    const rejecting = new (class extends PullRequestPort {
      readonly pushes = false
      async read(): Promise<PullRequestReading> {
        throw new Error('lost the socket')
      }
      async readLinked(): Promise<PullRequestReading> {
        throw new Error('lost the socket')
      }
    })()

    const chips = await threadChips({
      rows: [row({ threadId: 't1' })],
      home: HOME,
      pullRequests: rejecting,
      probe: probeWith({ [HOME]: main }, []),
    })

    expect(chips.size).toBe(0)
  })

  it('reads an open pull request with no checks as the link blue, not green', async () => {
    const main = checkout({ directory: HOME, branch: 'main' })
    const port = new FakePullRequests({ [checkoutKey(main)]: found({ number: 403 }) })

    const chips = await threadChips({
      rows: [row({ threadId: 't1' })],
      home: HOME,
      pullRequests: port,
      probe: probeWith({ [HOME]: main }, []),
    })

    expect(chips.get('t1')?.[0]?.ground).toBe(theme.link)
  })

  it('rows every linked pull request oldest first, ahead of the one the checkout stands on', async () => {
    const main = checkout({ directory: HOME, branch: 'dennis/third' })
    const port = new FakePullRequests(
      { [checkoutKey(main)]: found({ number: 415 }) },
      {
        'github.com/dennis/atlas#401': found({ number: 401 }),
        'github.com/dennis/atlas#412': found({ number: 412 }),
      },
    )

    const chips = await threadChips({
      rows: [
        row({
          threadId: 't1',
          pullRequests: [link({ number: 401, branch: 'dennis/first' }), link({ number: 412, branch: 'dennis/second' })],
        }),
      ],
      home: HOME,
      pullRequests: port,
      probe: probeWith({ [HOME]: main }, []),
    })

    expect(chips.get('t1')?.map((chip) => chip.label)).toEqual(['#401', '#412', '#415'])
  })

  it('does not repeat a linked pull request the checkout is already standing on', async () => {
    const main = checkout({ directory: HOME, branch: 'dennis/first' })
    const port = new FakePullRequests(
      { [checkoutKey(main)]: found({ number: 401 }) },
      { 'github.com/dennis/atlas#401': found({ number: 401 }) },
    )

    const chips = await threadChips({
      rows: [row({ threadId: 't1', pullRequests: [link({ number: 401, branch: 'dennis/first' })] })],
      home: HOME,
      pullRequests: port,
      probe: probeWith({ [HOME]: main }, []),
    })

    expect(chips.get('t1')?.map((chip) => chip.label)).toEqual(['#401'])
  })

  it('mutes a linked pull request whose state cannot be read, rather than dropping it', async () => {
    const port = new FakePullRequests({})

    const chips = await threadChips({
      rows: [row({ threadId: 't1', pullRequests: [link({ number: 401, branch: 'dennis/first' })] })],
      home: HOME,
      pullRequests: port,
      probe: async () => null,
    })

    const chip = chips.get('t1')?.[0]
    expect(chip?.label).toBe('#401')
    expect(chip?.ground).toBe(theme.selectedBg)
  })
})
