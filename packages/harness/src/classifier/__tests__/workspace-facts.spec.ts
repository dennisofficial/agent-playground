import { describe, expect, test } from 'bun:test'

import { EDeedRealm, EOccupancy, NO_FACTS, type WorktreeFact } from '@dltech/atlas-core'

import { GitWorkspaceFacts, type WorkspaceFactsDeps } from '../workspace-facts'
import {
  answerFor,
  fakeGit,
  lockToken,
  OUR_IDENTITY,
  OURS,
  porcelainOf,
  REPO,
  SIBLING,
  type GitCall,
  type GitReply,
} from './fake-git'

const THREE_WORKTREES = (lock?: string) =>
  porcelainOf([
    { path: REPO, branch: 'main' },
    { path: SIBLING, branch: 'eng-412-sidebar', ...(lock === undefined ? {} : { locked: lock }) },
    { path: OURS, branch: 'eng-500-facts' },
  ])

const CHANGED = {
  [SIBLING]: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  [OURS]: ['src/only.ts'],
}

const factsUnder = (args: {
  answer: (call: GitCall) => GitReply | undefined
  live?: boolean
  deps?: Partial<WorkspaceFactsDeps>
}) => {
  const git = fakeGit(args.answer)
  const facts = new GitWorkspaceFacts({
    runGit: git.runGit,
    canonicalPath: async (path) => path,
    ownIdentity: async () => OUR_IDENTITY,
    holderIsLive: async () => args.live ?? false,
    now: () => 0,
    ...args.deps,
  })

  return { git, facts }
}

const worktreeAt = (args: {
  worktrees: readonly WorktreeFact[]
  path: string
}): WorktreeFact | undefined => args.worktrees.find((worktree) => worktree.path === args.path)

const pathTarget = (value: string) => ({ realm: EDeedRealm.Path, value })

describe('the workspace facts a git repository can answer', () => {
  test('an unlocked sibling worktree is Unknown, and still reports what is uncommitted in it', async () => {
    const { facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(), changed: CHANGED }),
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.Path],
      targets: [pathTarget(`${SIBLING}/src`)],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    const sibling = worktreeAt({ worktrees: gathered.worktrees, path: SIBLING })
    expect(sibling?.occupancy).toBe(EOccupancy.Unknown)
    expect(sibling?.changedCount).toBe(3)
    expect(sibling?.heldBy).toBeUndefined()
  })

  test('a lock whose holder is still running is LiveOther, and names the pid', async () => {
    const held = lockToken({ label: 'thread t9', pid: 5150, start: 'Tue Feb  2 00:00:00 2035' })
    const { facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(held), changed: CHANGED }),
      live: true,
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.GitWorktree],
      targets: [{ realm: EDeedRealm.GitWorktree, value: SIBLING }],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    const sibling = worktreeAt({ worktrees: gathered.worktrees, path: SIBLING })
    expect(sibling?.occupancy).toBe(EOccupancy.LiveOther)
    expect(sibling?.heldBy).toBe(5150)
  })

  test('a lock whose holder is gone is Unknown, never Ours', async () => {
    const stale = lockToken({ label: 'thread t9', pid: 5150, start: 'Tue Feb  2 00:00:00 2035' })
    const { facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(stale), changed: CHANGED }),
      live: false,
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.GitWorktree],
      targets: [{ realm: EDeedRealm.GitWorktree, value: SIBLING }],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    const sibling = worktreeAt({ worktrees: gathered.worktrees, path: SIBLING })
    expect(sibling?.occupancy).toBe(EOccupancy.Unknown)
    expect(sibling?.occupancy).not.toBe(EOccupancy.Ours)
    expect(sibling?.changedCount).toBe(3)
  })

  test('the worktree the session is working in is Ours, though it holds no lock', async () => {
    const { facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(), changed: CHANGED }),
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.GitWorktree],
      targets: [],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(worktreeAt({ worktrees: gathered.worktrees, path: OURS })?.occupancy).toBe(
      EOccupancy.Ours,
    )
    expect(gathered.ownChangedPaths).toEqual(['src/only.ts'])
  })

  test('a path inside a known worktree pulls the worktree facts, though no worktree realm was asked for', async () => {
    const { facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(), changed: CHANGED }),
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.Path],
      targets: [pathTarget('../eng-412-sidebar')],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(gathered.gatheredFor).toContain(EDeedRealm.GitWorktree)
    expect(worktreeAt({ worktrees: gathered.worktrees, path: SIBLING })?.changedCount).toBe(3)
  })

  test('a path outside every worktree pulls no worktree facts', async () => {
    const { facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(), changed: CHANGED }),
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.Path],
      targets: [pathTarget('/etc/hosts')],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(gathered.gatheredFor).toEqual([EDeedRealm.Path])
    expect(gathered.worktrees).toEqual([])
  })

  test('a worktree nothing named is listed, but is not inspected', async () => {
    const { git, facts } = factsUnder({
      answer: answerFor({ listing: THREE_WORKTREES(), changed: CHANGED }),
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.GitWorktree],
      targets: [],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(
      worktreeAt({ worktrees: gathered.worktrees, path: SIBLING })?.changedCount,
    ).toBeUndefined()
    expect(git.timesCalled({ verb: 'status --porcelain', cwd: SIBLING })).toBe(0)
  })

  test('a ref no remote contains is not on a remote, and the worktree holding it is named', async () => {
    const { facts } = factsUnder({ answer: answerFor({ listing: THREE_WORKTREES() }) })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.GitRef],
      targets: [{ realm: EDeedRealm.GitRef, value: 'eng-412-sidebar' }],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(gathered.refs).toEqual([
      { ref: 'eng-412-sidebar', onRemote: false, checkedOutAt: [SIBLING] },
    ])
  })

  test('a ref git cannot read reads as on a remote, so history rewriting still has to ask', async () => {
    const { facts } = factsUnder({
      answer: (call) =>
        call.args[0] === 'branch'
          ? { ok: false, stderr: 'malformed object name' }
          : answerFor({ listing: THREE_WORKTREES() })(call),
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.GitRef],
      targets: [{ realm: EDeedRealm.GitRef, value: 'no-such-ref' }],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(gathered.refs[0]?.onRemote).toBe(true)
  })

  test('a git that cannot be run at all yields NO_FACTS rather than throwing', async () => {
    const { facts } = factsUnder({
      answer: () => {
        throw new Error('git is not on the path')
      },
    })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.Path, EDeedRealm.GitWorktree],
      targets: [pathTarget(`${SIBLING}/src`)],
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(gathered).toEqual(NO_FACTS)
    expect(gathered.gatheredFor).toEqual([])
  })

  test('a directory that is not a repository gathers nothing, and says so without failing', async () => {
    const { facts } = factsUnder({ answer: () => ({ ok: false, stderr: 'not a git repository' }) })

    const gathered = await facts.factsFor({
      realms: [EDeedRealm.Path],
      targets: [pathTarget('/tmp/scratch/notes.md')],
      projectDirectory: '/tmp/scratch',
      launchDirectory: '/tmp/scratch',
    })

    expect(gathered.repo).toBeUndefined()
    expect(gathered.gatheredFor).toEqual([])
    expect(gathered.regenerablePaths).toContain('node_modules')
  })

  test('a cold collection over five worktrees issues each git subprocess at most once', async () => {
    const many = [
      { path: REPO, branch: 'main' },
      { path: `${REPO}/.claude/worktrees/one`, branch: 'one' },
      { path: `${REPO}/.claude/worktrees/two`, branch: 'two' },
      { path: `${REPO}/.claude/worktrees/three`, branch: 'three' },
      { path: OURS, branch: 'eng-500-facts' },
    ]
    const { git, facts } = factsUnder({ answer: answerFor({ listing: porcelainOf(many) }) })

    await facts.factsFor({
      realms: [EDeedRealm.Path],
      targets: many.map((entry) => pathTarget(entry.path)),
      projectDirectory: OURS,
      launchDirectory: REPO,
    })

    expect(git.timesCalled({ verb: 'worktree list' })).toBe(1)
    for (const entry of many) {
      expect(git.timesCalled({ verb: 'status --porcelain', cwd: entry.path })).toBe(1)
    }
  })
})
