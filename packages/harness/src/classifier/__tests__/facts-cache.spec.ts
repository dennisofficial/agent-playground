import { describe, expect, test } from 'bun:test'

import { EDeedRealm } from '@dltech/atlas-core'

import { DIRTINESS_TTL_MS, EFactScope, FactsCache } from '../facts-cache'
import { GitWorkspaceFacts } from '../workspace-facts'
import { answerFor, fakeGit, OUR_IDENTITY, OURS, porcelainOf, REPO, SIBLING } from './fake-git'

const LISTING = porcelainOf([
  { path: REPO, branch: 'main' },
  { path: SIBLING, branch: 'eng-412-sidebar' },
  { path: OURS, branch: 'eng-500-facts' },
])

const REQUEST = {
  realms: [EDeedRealm.Path],
  targets: [{ realm: EDeedRealm.Path, value: `${SIBLING}/src/a.ts` }],
  projectDirectory: OURS,
  launchDirectory: REPO,
}

const cachedFacts = () => {
  let clock = 0
  const git = fakeGit(answerFor({ listing: LISTING, changed: { [SIBLING]: ['src/a.ts'] } }))
  const facts = new GitWorkspaceFacts({
    runGit: git.runGit,
    canonicalPath: async (path) => path,
    ownIdentity: async () => OUR_IDENTITY,
    holderIsLive: async () => false,
    now: () => clock,
  })

  return {
    git,
    facts,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('the cache in front of the git subprocesses', () => {
  test('six concurrent identical requests collect the workspace once', async () => {
    const { git, facts } = cachedFacts()

    const gathered = await Promise.all(Array.from({ length: 6 }, () => facts.factsFor(REQUEST)))

    expect(git.timesCalled({ verb: 'worktree list' })).toBe(1)
    expect(git.timesCalled({ verb: 'status --porcelain', cwd: SIBLING })).toBe(1)
    expect(git.timesCalled({ verb: 'status --porcelain', cwd: OURS })).toBe(1)
    for (const answer of gathered) expect(answer.worktrees).toHaveLength(3)
  })

  test('a second request inside the window runs no git at all', async () => {
    const { git, facts } = cachedFacts()

    await facts.factsFor(REQUEST)
    const before = git.calls.length
    await facts.factsFor(REQUEST)

    expect(git.calls.length).toBe(before)
  })

  test('invalidate forces the whole workspace to be read again', async () => {
    const { git, facts } = cachedFacts()

    await facts.factsFor(REQUEST)
    facts.invalidate()
    await facts.factsFor(REQUEST)

    expect(git.timesCalled({ verb: 'worktree list' })).toBe(2)
    expect(git.timesCalled({ verb: 'status --porcelain', cwd: SIBLING })).toBe(2)
  })

  test('dirtiness expires on its own clock while worktree membership stands', async () => {
    const { git, facts, advance } = cachedFacts()

    await facts.factsFor(REQUEST)
    advance(DIRTINESS_TTL_MS + 1)
    await facts.factsFor(REQUEST)

    expect(git.timesCalled({ verb: 'status --porcelain', cwd: SIBLING })).toBe(2)
    expect(git.timesCalled({ verb: 'worktree list' })).toBe(1)
  })

  test('a collection that failed is not remembered as the answer', async () => {
    let broken = true
    const git = fakeGit((call) =>
      broken && call.args[0] === 'worktree'
        ? { ok: false, stderr: 'boom' }
        : answerFor({ listing: LISTING })(call),
    )
    const facts = new GitWorkspaceFacts({
      runGit: git.runGit,
      canonicalPath: async (path) => path,
      ownIdentity: async () => OUR_IDENTITY,
      holderIsLive: async () => false,
      now: () => 0,
    })

    expect((await facts.factsFor(REQUEST)).repo).toBeUndefined()
    broken = false
    facts.invalidate()

    expect((await facts.factsFor(REQUEST)).repo).toBe(REPO)
  })

  test('prewarm clears what is only true for a turn and leaves the session cache alone', async () => {
    const { git, facts } = cachedFacts()

    await facts.factsFor(REQUEST)
    facts.prewarm({ projectDirectory: OURS, launchDirectory: REPO })
    await facts.factsFor(REQUEST)

    expect(git.timesCalled({ verb: 'worktree list' })).toBe(1)
  })

  test('a slot set registered under one scope is untouched when another expires', () => {
    const cache = new FactsCache({ now: () => 0 })
    const session = cache.slots<number>({ scope: EFactScope.Session })
    const turn = cache.slots<number>({ scope: EFactScope.Turn })
    let collected = 0
    const collect = async (): Promise<number> => {
      collected += 1
      return collected
    }

    void session.read({ key: 'k', collect })
    void turn.read({ key: 'k', collect })
    cache.expire({ scope: EFactScope.Turn })
    void session.read({ key: 'k', collect })
    void turn.read({ key: 'k', collect })

    expect(collected).toBe(3)
  })
})
