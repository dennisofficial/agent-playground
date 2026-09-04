import { afterEach, describe, expect, it } from 'bun:test'

import { EForkMode, EWorktreeExit, toThreadId, toRunId, type EventDraft } from '@dltech/atlas-core'

import type { PrismaClient } from '../../../prisma/generated/client'
import { openSecondWriter, openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })

const refuseHeadOf = async ({
  prisma,
  head,
}: {
  prisma: PrismaClient
  head: number
}): Promise<void> => {
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER refuse_head AFTER UPDATE OF head ON "Thread" WHEN NEW.head = ${head}
     BEGIN SELECT RAISE(ABORT, 'head refused'); END`,
  )
}

const openFixture = async (): Promise<StoreFixture> => {
  fixture = await openStoreFixture()
  return fixture
}

afterEach(async () => {
  await fixture.close()
})

describe('PrismaThreadStore', () => {
  it('creates a thread with a title and an empty head', async () => {
    const { threads } = await openFixture()

    const thread = await threads.create({ title: 'refactor the log' })

    expect(thread.title).toBe('refactor the log')
    expect(thread.head).toBe(0)
    expect(await threads.find({ threadId: thread.id })).toEqual(thread)
  })

  it('has no most recent thread before anything is written', async () => {
    const { threads } = await openFixture()

    expect(await threads.mostRecent({ project: '/work' })).toBeUndefined()
  })

  it('answers most recent with a query rather than a scan of events', async () => {
    const { threads, log } = await openFixture()

    const older = await threads.create({ title: 'older', workspace: '/work' })
    const newer = await threads.create({ title: 'newer', workspace: '/work' })
    await log.append({ threadId: older.id, runId, drafts: [said('touched last')] })

    const recent = await threads.mostRecent({ project: '/work' })
    expect(recent?.id).toBe(older.id)
    expect(recent?.head).toBe(1)
    expect(newer.id).not.toBe(older.id)
  })

  it('tracks the head of the thread it is asked about', async () => {
    const { threads, log } = await openFixture()

    const thread = await threads.create({ title: 'work' })
    await log.append({ threadId: thread.id, runId, drafts: [said('one'), said('two')] })

    expect((await threads.find({ threadId: thread.id }))?.head).toBe(2)
  })

  it('discovers a thread that only ever appeared in an append', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('implicit')

    await log.append({ threadId, runId, drafts: [said('hello')] })

    const found = await threads.find({ threadId })
    expect(found?.id).toBe(threadId)
    expect(found?.head).toBe(1)
    expect(found?.title).toBeUndefined()
  })

  it('claims no workspace for a thread that only ever appeared in an append', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('implicit')

    await log.append({ threadId, runId, drafts: [said('hello')] })

    expect((await threads.find({ threadId }))?.workspace).toBeNull()
    expect(await threads.list({ project: '/work' })).toEqual([])
  })

  it('renames a thread without disturbing its head', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('implicit')
    await log.append({ threadId, runId, drafts: [said('hello')] })

    await threads.rename({ threadId, title: 'named later' })

    expect(await threads.find({ threadId })).toMatchObject({ title: 'named later', head: 1 })
  })

  it('carries no model until one is chosen for the conversation', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('unchosen')
    await log.append({ threadId, runId, drafts: [said('hello')] })

    expect((await threads.find({ threadId }))?.model).toBeUndefined()
  })

  it('remembers the model chosen for a conversation without counting it as activity', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('chosen')
    await log.append({ threadId, runId, drafts: [said('hello')] })
    const before = await threads.find({ threadId })

    await threads.chooseModel({
      threadId,
      model: { ref: 'anthropic/claude-opus-5', effort: 'high' },
    })

    const after = await threads.find({ threadId })
    expect(after?.model).toEqual({ ref: 'anthropic/claude-opus-5', effort: 'high' })
    expect(after?.updatedAt).toBe(before?.updatedAt ?? '')
    expect(after?.head).toBe(before?.head ?? -1)
  })

  it('carries the chosen model onto a fork, which continues the same conversation', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('forked-from')
    await log.append({ threadId, runId, drafts: [said('hello')] })
    await threads.chooseModel({
      threadId,
      model: { ref: 'anthropic/claude-opus-5', effort: 'high' },
    })

    const fork = await threads.fork({ from: threadId, seq: 1, mode: EForkMode.Reference })

    expect(fork.model).toEqual({ ref: 'anthropic/claude-opus-5', effort: 'high' })
  })

  it('finds nothing for a thread that does not exist', async () => {
    const { threads } = await openFixture()

    expect(await threads.find({ threadId: toThreadId('nope') })).toBeUndefined()
  })
})

describe('PrismaThreadStore.rewind', () => {
  it('drops the event suffix and moves the head back', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ title: 'work' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [said('one'), said('two'), said('three')],
    })

    await threads.rewind({ threadId: thread.id, toSeq: 1 })

    expect((await log.read({ threadId: thread.id })).map((event) => event.seq)).toEqual([1])
    expect((await threads.find({ threadId: thread.id }))?.head).toBe(1)
  })

  it('lets the next append take the sequence the rewind freed', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ title: 'work' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [said('one'), said('two'), said('three')],
    })

    await threads.rewind({ threadId: thread.id, toSeq: 1 })
    const appended = await log.append({ threadId: thread.id, runId, drafts: [said('two again')] })

    expect(appended.map((event) => event.seq)).toEqual([2])
    expect((await log.read({ threadId: thread.id })).map((event) => event.seq)).toEqual([1, 2])
    expect((await threads.find({ threadId: thread.id }))?.head).toBe(2)
  })

  it('empties the thread when rewound to zero', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ title: 'work' })
    await log.append({ threadId: thread.id, runId, drafts: [said('one'), said('two')] })

    await threads.rewind({ threadId: thread.id, toSeq: 0 })

    expect(await log.read({ threadId: thread.id })).toEqual([])
    expect((await threads.find({ threadId: thread.id }))?.head).toBe(0)
    expect(
      (await log.append({ threadId: thread.id, runId, drafts: [said('fresh')] })).at(0)?.seq,
    ).toBe(1)
  })

  it('truncates only the thread it was asked about', async () => {
    const { threads, log } = await openFixture()
    const kept = await threads.create({ title: 'kept' })
    const cut = await threads.create({ title: 'cut' })
    await log.append({ threadId: kept.id, runId, drafts: [said('one'), said('two')] })
    await log.append({ threadId: cut.id, runId, drafts: [said('one'), said('two')] })

    await threads.rewind({ threadId: cut.id, toSeq: 1 })

    expect((await log.read({ threadId: kept.id })).length).toBe(2)
    expect((await threads.find({ threadId: kept.id }))?.head).toBe(2)
  })

  it('keeps the suffix when the head update fails', async () => {
    const { threads, log, prisma } = await openFixture()
    const thread = await threads.create({ title: 'work' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [said('one'), said('two'), said('three')],
    })
    await refuseHeadOf({ prisma, head: 1 })

    await expect(threads.rewind({ threadId: thread.id, toSeq: 1 })).rejects.toThrow()

    expect((await log.read({ threadId: thread.id })).map((event) => event.seq)).toEqual([1, 2, 3])
    expect((await threads.find({ threadId: thread.id }))?.head).toBe(3)
  })

  it('survives a rewind racing an append from another writer', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ title: 'work' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [said('one'), said('two'), said('three')],
    })
    const second = await openSecondWriter(fixture)

    try {
      await Promise.all([
        threads.rewind({ threadId: thread.id, toSeq: 2 }),
        second.log.append({ threadId: thread.id, runId, drafts: [said('four')] }),
      ])

      const seqs = (await log.read({ threadId: thread.id })).map((event) => event.seq)
      expect([2, 3]).toContain(seqs.length)
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_unused, index) => index + 1))
      expect((await threads.find({ threadId: thread.id }))?.head).toBe(seqs.length)
    } finally {
      await second.close()
    }
  })
})

describe('threads scoped to a project', () => {
  it('records the workspace and the repo it was opened in', async () => {
    const { threads } = await openFixture()

    const thread = await threads.create({ workspace: '/wt/feature', repo: '/repo' })

    expect(thread.workspace).toBe('/wt/feature')
    expect(thread.repo).toBe('/repo')
  })

  it('does not resume another workspace thread, however recently it was touched', async () => {
    const { threads, log } = await openFixture()

    const elsewhere = await threads.create({ title: 'other repo', workspace: '/other' })
    const here = await threads.create({ title: 'this repo', workspace: '/here' })
    await log.append({ threadId: elsewhere.id, runId, drafts: [said('touched last')] })

    expect((await threads.mostRecent({ project: '/here' }))?.id).toBe(here.id)
  })

  it('has no most recent thread in a workspace nothing has been opened in', async () => {
    const { threads } = await openFixture()
    await threads.create({ workspace: '/other' })

    expect(await threads.mostRecent({ project: '/here' })).toBeUndefined()
  })

  it('adopts a thread that carried no workspace, so it lists where it was reopened', async () => {
    const { threads, log } = await openFixture()
    const threadId = toThreadId('unattributed')
    await log.append({ threadId, runId, drafts: [said('hello')] })

    await threads.adopt({ threadId, workspace: '/here', repo: '/repo' })

    expect((await threads.list({ project: '/here' })).map((row) => row.id)).toEqual([threadId])
    expect((await threads.find({ threadId }))?.repo).toBe('/repo')
  })

  it('lists only the threads of the workspace asked about', async () => {
    const { threads } = await openFixture()

    await threads.create({ title: 'theirs', workspace: '/other' })
    await threads.create({ title: 'mine', workspace: '/here' })

    expect((await threads.list({ project: '/here' })).map((row) => row.title)).toEqual(['mine'])
  })

  it('lists the most recently touched thread first', async () => {
    const { threads, log } = await openFixture()

    const older = await threads.create({ title: 'older', workspace: '/here' })
    await threads.create({ title: 'newer', workspace: '/here' })
    await log.append({ threadId: older.id, runId, drafts: [said('touched last')] })

    expect((await threads.list({ project: '/here' })).map((row) => row.title)).toEqual([
      'older',
      'newer',
    ])
  })

  it('takes no more threads than the limit asked for', async () => {
    const { threads } = await openFixture()
    for (const title of ['one', 'two', 'three']) {
      await threads.create({ title, workspace: '/here' })
    }

    expect(await threads.list({ project: '/here', limit: 2 })).toHaveLength(2)
  })

  it('lists the threads of every worktree of a project', async () => {
    const { threads } = await openFixture()

    await threads.create({ title: 'on main', workspace: '/repo', repo: '/repo' })
    await threads.create({ title: 'on feature', workspace: '/wt/feature', repo: '/repo' })

    expect((await threads.list({ project: '/repo' })).map((row) => row.title)).toEqual([
      'on feature',
      'on main',
    ])
  })

  it('answers most recent across the worktrees of a project', async () => {
    const { threads, log } = await openFixture()

    const feature = await threads.create({ workspace: '/wt/feature', repo: '/repo' })
    const main = await threads.create({ workspace: '/repo', repo: '/repo' })
    await log.append({ threadId: feature.id, runId, drafts: [said('touched last')] })

    expect((await threads.mostRecent({ project: '/repo' }))?.id).toBe(feature.id)
    expect((await threads.mostRecent({ project: '/wt/feature' }))?.id).toBe(feature.id)
    expect(main.id).not.toBe(feature.id)
  })

  it('keeps the threads of another project out, however shared the naming', async () => {
    const { threads } = await openFixture()

    await threads.create({ title: 'theirs', workspace: '/other', repo: '/other' })
    await threads.create({ title: 'mine', workspace: '/wt/feature', repo: '/repo' })

    expect((await threads.list({ project: '/repo' })).map((row) => row.title)).toEqual(['mine'])
  })

  it('still lists a main-checkout thread that predates repo attribution', async () => {
    const { threads } = await openFixture()

    await threads.create({ title: 'legacy', workspace: '/repo', repo: null })

    expect((await threads.list({ project: '/repo' })).map((row) => row.title)).toEqual(['legacy'])
  })

  it('cannot place a worktree thread that predates repo attribution', async () => {
    const { threads } = await openFixture()

    await threads.create({ title: 'legacy worktree', workspace: '/wt/old', repo: null })

    expect(await threads.list({ project: '/repo' })).toEqual([])
    expect((await threads.list({ project: '/wt/old' })).map((row) => row.title)).toEqual([
      'legacy worktree',
    ])
  })

  it('hands a fork the workspace its source was opened in', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here', repo: '/repo' })
    await log.append({ threadId: source.id, runId, drafts: [said('one')] })

    const forked = await threads.fork({ from: source.id, seq: 1, mode: EForkMode.Reference })

    expect(forked.workspace).toBe('/here')
    expect(forked.repo).toBe('/repo')
    expect((await threads.list({ project: '/here' })).map((row) => row.id)).toContain(forked.id)
  })
})

describe('the worktree a listed thread is standing in', () => {
  const entered = (path: string, branch: string): EventDraft => ({
    type: 'worktree-entered',
    path,
    branch,
  })
  const exited = (path: string): EventDraft => ({
    type: 'worktree-exited',
    path,
    action: EWorktreeExit.Keep,
  })

  it('is nothing for a thread that never moved', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({ threadId: thread.id, runId, drafts: [said('hello')] })

    expect((await threads.list({ project: '/here' }))[0]?.worktree).toBeUndefined()
  })

  it('is the worktree the thread last entered', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [said('hello'), entered('/here/.worktrees/fix-a1b2', 'dennis/fix-a1b2')],
    })

    expect((await threads.list({ project: '/here' }))[0]?.worktree).toEqual({
      path: '/here/.worktrees/fix-a1b2',
      branch: 'dennis/fix-a1b2',
    })
  })

  it('is nothing once the thread leaves the worktree again', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [
        entered('/here/.worktrees/fix-a1b2', 'dennis/fix-a1b2'),
        exited('/here/.worktrees/fix-a1b2'),
      ],
    })

    expect((await threads.list({ project: '/here' }))[0]?.worktree).toBeUndefined()
  })

  it('comes back to a worktree the thread re-entered after leaving another', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [
        entered('/here/.worktrees/first', 'dennis/first'),
        exited('/here/.worktrees/first'),
        entered('/here/.worktrees/second', 'dennis/second'),
      ],
    })

    expect((await threads.list({ project: '/here' }))[0]?.worktree?.branch).toBe('dennis/second')
  })

  it('is inherited by a reference fork, whose log starts empty', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: source.id,
      runId,
      drafts: [said('hello'), entered('/here/.worktrees/fix-a1b2', 'dennis/fix-a1b2')],
    })
    const forked = await threads.fork({ from: source.id, seq: 2, mode: EForkMode.Reference })

    const listed = await threads.list({ project: '/here' })
    expect(listed.find((row) => row.id === forked.id)?.worktree?.branch).toBe('dennis/fix-a1b2')
  })

  it('stops at the fork point, so a worktree the source entered later is not inherited', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({ threadId: source.id, runId, drafts: [said('hello')] })
    const forked = await threads.fork({ from: source.id, seq: 1, mode: EForkMode.Reference })
    await log.append({
      threadId: source.id,
      runId,
      drafts: [entered('/here/.worktrees/fix-a1b2', 'dennis/fix-a1b2')],
    })

    const listed = await threads.list({ project: '/here' })
    expect(listed.find((row) => row.id === forked.id)?.worktree).toBeUndefined()
  })

  it('stands where a copy fork stands, whose copied log carries the move with it', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: source.id,
      runId,
      drafts: [said('hello'), entered('/here/.worktrees/fix-a1b2', 'dennis/fix-a1b2')],
    })
    const copied = await threads.fork({ from: source.id, seq: 2, mode: EForkMode.Copy })

    const listed = await threads.list({ project: '/here' })
    expect(listed.find((row) => row.id === copied.id)?.worktree?.branch).toBe('dennis/fix-a1b2')
  })
})

describe('the pull requests a listed thread is linked to', () => {
  const linked = ({ number, branch }: { number: number; branch: string }): EventDraft => ({
    type: 'pull-request-linked',
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    repo: 'github.com/acme/app',
    branch,
  })

  it('is nothing for a thread that never linked one', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({ threadId: thread.id, runId, drafts: [said('hello')] })

    expect((await threads.list({ project: '/here' }))[0]?.pullRequests).toBeUndefined()
  })

  it('is the links the thread recorded, oldest first', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [
        linked({ number: 401, branch: 'dennis/first' }),
        linked({ number: 412, branch: 'dennis/second' }),
      ],
    })

    expect((await threads.list({ project: '/here' }))[0]?.pullRequests).toEqual([
      {
        number: 401,
        url: 'https://github.com/acme/app/pull/401',
        repo: 'github.com/acme/app',
        branch: 'dennis/first',
      },
      {
        number: 412,
        url: 'https://github.com/acme/app/pull/412',
        repo: 'github.com/acme/app',
        branch: 'dennis/second',
      },
    ])
  })

  it('keeps a repeat link in its first position, refreshing its fields', async () => {
    const { threads, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: thread.id,
      runId,
      drafts: [
        linked({ number: 401, branch: 'dennis/first' }),
        linked({ number: 412, branch: 'dennis/second' }),
        linked({ number: 401, branch: 'dennis/first-rebased' }),
      ],
    })

    const pullRequests = (await threads.list({ project: '/here' }))[0]?.pullRequests
    expect(pullRequests?.map((pr) => pr.number)).toEqual([401, 412])
    expect(pullRequests?.[0]?.branch).toBe('dennis/first-rebased')
  })

  it('is inherited by a reference fork, up to the fork point', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({
      threadId: source.id,
      runId,
      drafts: [said('hello'), linked({ number: 401, branch: 'dennis/first' })],
    })
    const forked = await threads.fork({ from: source.id, seq: 2, mode: EForkMode.Reference })
    await log.append({
      threadId: source.id,
      runId,
      drafts: [linked({ number: 412, branch: 'dennis/second' })],
    })

    const listed = await threads.list({ project: '/here' })
    expect(
      listed.find((row) => row.id === forked.id)?.pullRequests?.map((pr) => pr.number),
    ).toEqual([401])
  })
})
