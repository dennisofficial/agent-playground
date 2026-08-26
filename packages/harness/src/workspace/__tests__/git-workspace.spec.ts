import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createGitWorkspace } from '../git-workspace'
import { createTemporaryRepository, type TemporaryRepository } from './temporary-repository'

let repository: TemporaryRepository

beforeEach(async () => {
  repository = await createTemporaryRepository()
})

afterEach(async () => {
  await repository.dispose()
})

describe('snapshotting a working tree and restoring it', () => {
  it('brings a modified tracked file back to the content it had at the snapshot', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 2\n' })

    const snapshotId = await workspace.snapshot({ label: 'before edit' })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 999\n' })
    await workspace.restore({ snapshotId })

    expect(await repository.read({ path: 'tracked.ts' })).toBe('export const a = 2\n')
  })
})

describe('snapshotting a working tree the developer is in the middle of', () => {
  it('leaves git status, the index, HEAD and every ref byte-identical', async () => {
    await repository.write({ path: 'staged.ts', content: 'export const staged = 1\n' })
    await repository.git(['add', 'staged.ts'])
    await repository.write({ path: 'staged.ts', content: 'export const staged = 2\n' })
    await repository.write({ path: 'untracked.ts', content: 'export const untracked = 1\n' })
    await repository.write({ path: 'ignored/artifact.txt', content: 'build output\n' })
    await repository.remove({ path: 'tracked.ts' })

    const before = await repository.observableState()
    const workspace = createGitWorkspace({ root: repository.root })
    await workspace.snapshot({ label: 'mid-edit' })
    const after = await repository.observableState()

    expect(after).toEqual(before)
  })

  it('writes no stash entry and leaves no reflog for one', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 3\n' })

    await workspace.snapshot({ label: 'no stash' })

    expect(await Bun.file(`${repository.root}/.git/refs/stash`).exists()).toBe(false)
    expect(await Bun.file(`${repository.root}/.git/logs/refs/stash`).exists()).toBe(false)
  })
})

describe('the observable state the snapshot constraint is asserted against', () => {
  it('does change when something stages a file the way a stash-based snapshot would', async () => {
    await repository.write({ path: 'untracked.ts', content: 'export const untracked = 1\n' })

    const before = await repository.observableState()
    await repository.git(['add', '--all'])
    const after = await repository.observableState()

    expect(after).not.toEqual(before)
  })
})

describe('restoring a snapshot of a working tree git does not track cleanly', () => {
  it('brings back an untracked file the tool deleted', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'notes/scratch.md', content: 'draft\n' })

    const snapshotId = await workspace.snapshot({ label: 'with untracked' })
    await repository.remove({ path: 'notes' })
    await workspace.restore({ snapshotId })

    expect(await repository.read({ path: 'notes/scratch.md' })).toBe('draft\n')
  })

  it('deletes again a tracked file that was deleted when the snapshot was taken', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.remove({ path: 'tracked.ts' })

    const snapshotId = await workspace.snapshot({ label: 'with deletion' })
    await repository.write({ path: 'tracked.ts', content: 'export const resurrected = 1\n' })
    await workspace.restore({ snapshotId })

    expect(await Bun.file(`${repository.root}/tracked.ts`).exists()).toBe(false)
  })

  it('preserves a file with CRLF line endings byte for byte', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'windows.txt', content: 'first\r\nsecond\r\n' })

    const snapshotId = await workspace.snapshot({ label: 'with crlf' })
    await repository.write({ path: 'windows.txt', content: 'clobbered\n' })
    await workspace.restore({ snapshotId })

    expect(await repository.read({ path: 'windows.txt' })).toBe('first\r\nsecond\r\n')
  })

  it('removes a file the tool created after the snapshot', async () => {
    const workspace = createGitWorkspace({ root: repository.root })

    const snapshotId = await workspace.snapshot({ label: 'before creation' })
    await repository.write({ path: 'generated/output.ts', content: 'export const generated = 1\n' })
    await workspace.restore({ snapshotId })

    expect(await Bun.file(`${repository.root}/generated/output.ts`).exists()).toBe(false)
  })

  it('leaves ignored files alone, so a build directory survives a restore', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'ignored/artifact.txt', content: 'build output\n' })

    const snapshotId = await workspace.snapshot({ label: 'with ignored' })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 4\n' })
    await workspace.restore({ snapshotId })

    expect(await repository.read({ path: 'ignored/artifact.txt' })).toBe('build output\n')
  })
})

describe('taking two snapshots of the same content', () => {
  it('names them with the same id, because the id is the content', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 5\n' })

    const first = await workspace.snapshot({ label: 'first' })
    const second = await workspace.snapshot({ label: 'second' })

    expect(second).toBe(first)
  })

  it('names them differently once the content differs', async () => {
    const workspace = createGitWorkspace({ root: repository.root })

    const first = await workspace.snapshot({ label: 'first' })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 6\n' })
    const second = await workspace.snapshot({ label: 'second' })

    expect(second).not.toBe(first)
  })
})

describe('snapshotting a directory that is not inside a git worktree', () => {
  it('fails with a message naming the label the snapshot was for', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'atlas-not-a-repository-'))
    try {
      const workspace = createGitWorkspace({ root: outside })

      await expect(workspace.snapshot({ label: 'call-7 write' })).rejects.toThrow(/call-7 write/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('snapshotting from a subdirectory of the worktree', () => {
  it('captures the whole worktree, so a change outside that directory still restores', async () => {
    await repository.write({ path: 'nested/deep/file.ts', content: 'export const deep = 1\n' })
    const workspace = createGitWorkspace({ root: join(repository.root, 'nested', 'deep') })

    const snapshotId = await workspace.snapshot({ label: 'from nested' })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 7\n' })
    await workspace.restore({ snapshotId })

    expect(await repository.read({ path: 'tracked.ts' })).toBe('export const a = 1\n')
  })
})

describe('two snapshots asked for at once', () => {
  it('both succeed, because the private index is written one call at a time', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 8\n' })

    const ids = await Promise.all([
      workspace.snapshot({ label: 'first' }),
      workspace.snapshot({ label: 'second' }),
    ])

    expect(ids[0]).toBe(ids[1])
  })
})

describe('snapshotting when the developer index cannot be reused', () => {
  it('falls back to a private index of its own and still captures the worktree', async () => {
    const developerIndex = join(repository.root, '.git', 'index')
    await Bun.write(developerIndex, 'not an index at all')
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 9\n' })

    const snapshotId = await workspace.snapshot({ label: 'corrupt index' })
    await repository.write({ path: 'tracked.ts', content: 'export const a = 10\n' })
    await workspace.restore({ snapshotId })

    expect(await repository.read({ path: 'tracked.ts' })).toBe('export const a = 9\n')
    expect(await Bun.file(developerIndex).text()).toBe('not an index at all')
  })
})

describe('restoring a snapshot', () => {
  it('rewrites worktree files without staging, unstaging or moving HEAD', async () => {
    const workspace = createGitWorkspace({ root: repository.root })
    await repository.write({ path: 'staged.ts', content: 'export const staged = 1\n' })
    await repository.git(['add', 'staged.ts'])

    const snapshotId = await workspace.snapshot({ label: 'before edit' })
    const before = await repository.observableState()
    await repository.write({ path: 'tracked.ts', content: 'export const a = 11\n' })
    await workspace.restore({ snapshotId })
    const after = await repository.observableState()

    expect(after.stagedEntries).toBe(before.stagedEntries)
    expect(after.head).toBe(before.head)
    expect(after.refs).toBe(before.refs)
    expect(after.status).toBe(before.status)
  })
})
