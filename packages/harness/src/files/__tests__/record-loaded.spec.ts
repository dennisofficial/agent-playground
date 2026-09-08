import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toThreadId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { recordLoadedFiles } from '../record-loaded'
import { InMemoryFileReadState } from '../read-state'
import { movedSince } from '../staleness'

const thread = toThreadId('thread-1')

const scratch = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'atlas-record-loaded-'))

describe('recordLoadedFiles', () => {
  it('records a whole-file view that matches the file on disk', async () => {
    const root = await scratch()
    const path = join(root, 'CLAUDE.md')
    await writeFile(path, 'be terse')

    const readState = new InMemoryFileReadState()
    await recordLoadedFiles({ readState, threadId: thread, loaded: [{ path, wholeFile: true }] })

    const view = readState.viewOf({ threadId: thread, path })
    expect(view?.wholeFile).toBe(true)
    expect(view).not.toBeUndefined()
    if (view === undefined) return

    const stats = await stat(path)
    expect(await movedSince({ view, stats, path })).toBe(false)
  })

  it('marks a partially shown file as not whole, so a whole-file replace stays refused', async () => {
    const root = await scratch()
    const path = join(root, 'MEMORY.md')
    await writeFile(path, '- [One](one.md)')

    const readState = new InMemoryFileReadState()
    await recordLoadedFiles({ readState, threadId: thread, loaded: [{ path, wholeFile: false }] })

    expect(readState.viewOf({ threadId: thread, path })?.wholeFile).toBe(false)
  })

  it('notices when the file changed after it was injected', async () => {
    const root = await scratch()
    const path = join(root, 'AGENTS.md')
    await writeFile(path, 'first')

    const readState = new InMemoryFileReadState()
    await recordLoadedFiles({ readState, threadId: thread, loaded: [{ path, wholeFile: true }] })

    await writeFile(path, 'second, written by someone else and longer')

    const view = readState.viewOf({ threadId: thread, path })
    expect(view).not.toBeUndefined()
    if (view === undefined) return

    const stats = await stat(path)
    expect(await movedSince({ view, stats, path })).toBe(true)
  })

  it('skips a path that does not exist', async () => {
    const root = await scratch()
    const readState = new InMemoryFileReadState()
    await recordLoadedFiles({
      readState,
      threadId: thread,
      loaded: [{ path: join(root, 'missing.md'), wholeFile: true }],
    })

    expect(readState.viewOf({ threadId: thread, path: join(root, 'missing.md') })).toBeUndefined()
  })

  it('skips a directory', async () => {
    const root = await scratch()
    const readState = new InMemoryFileReadState()
    await recordLoadedFiles({ readState, threadId: thread, loaded: [{ path: root, wholeFile: true }] })

    expect(readState.viewOf({ threadId: thread, path: root })).toBeUndefined()
  })

  it('keys views per thread, so the injection vouches for no other thread', async () => {
    const root = await scratch()
    const path = join(root, 'CLAUDE.md')
    await writeFile(path, 'be terse')

    const readState = new InMemoryFileReadState()
    await recordLoadedFiles({ readState, threadId: thread, loaded: [{ path, wholeFile: true }] })

    expect(readState.viewOf({ threadId: toThreadId('thread-2'), path })).toBeUndefined()
  })
})
