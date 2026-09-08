import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeforeTurnHook, EContextSlot, MAX_INDEX_LINES, toThreadId } from '@dltech/atlas-core'

import { createIsolatedContainer, portToken } from '../../container/injection'
import { InMemoryFileReadState } from '../../files/read-state'
import { resolveHookChain } from '../../hooks/resolve-hooks'

import { LoadMemoryHook } from '../../hooks/load-memory'
import { ensureMemoryDirectories, memoryDirectoriesFor, readMemoryIndexes } from '../read-memory'

const scratch = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'atlas-memory-'))

const directoriesIn = (atlasHome: string) =>
  memoryDirectoriesFor({ atlasHome, repoRoot: '/home/dev/code/atlas' })

describe('memoryDirectoriesFor', () => {
  it('separates the global directory from the repository one', () => {
    const directories = directoriesIn('/home/dev/.atlas')
    expect(directories.user).toBe('/home/dev/.atlas/memory')
    expect(directories.project).toBe('/home/dev/.atlas/projects/-home-dev-code-atlas/memory')
  })

  it('gives every worktree of a repository the same directory', () => {
    const fromRepo = memoryDirectoriesFor({ atlasHome: '/h', repoRoot: '/code/atlas' })
    const fromWorktree = memoryDirectoriesFor({ atlasHome: '/h', repoRoot: '/code/atlas' })
    expect(fromWorktree.project).toBe(fromRepo.project)
  })
})

describe('readMemoryIndexes', () => {
  it('reads nothing when the directories are empty', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)

    const { indexes, problems } = await readMemoryIndexes(directories)
    expect(indexes).toEqual([])
    expect(problems).toEqual([])
  })

  it('reads both indexes and tags them as memory', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    await writeFile(join(directories.user, 'MEMORY.md'), '- [Who](who.md) — a data scientist')
    await writeFile(join(directories.project, 'MEMORY.md'), '- [Bun](bun.md) — deflate is raw')

    const { indexes } = await readMemoryIndexes(directories)
    expect(indexes).toHaveLength(2)
    expect(indexes.every((index) => index.slot === EContextSlot.Memory)).toBe(true)
    expect(indexes[0]?.content).toContain('a data scientist')
    expect(indexes[1]?.content).toContain('deflate is raw')
  })

  it('skips an index that holds only whitespace', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    await writeFile(join(directories.project, 'MEMORY.md'), '   \n\n  ')

    const { indexes } = await readMemoryIndexes(directories)
    expect(indexes).toEqual([])
  })

  it('bounds an oversized index rather than dropping it silently', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    const long = Array.from({ length: MAX_INDEX_LINES + 50 }, (_, at) => `- entry ${at}`).join('\n')
    await writeFile(join(directories.project, 'MEMORY.md'), long)

    const { indexes } = await readMemoryIndexes(directories)
    expect(indexes).toHaveLength(1)
    expect(indexes[0]?.content).toContain('Only part of this index was loaded')
    expect(indexes[0]?.wholeFile).toBe(false)
  })

  it('marks an index that fit the bounds as whole', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    await writeFile(join(directories.project, 'MEMORY.md'), '- [One](one.md) — a hook')

    const { indexes } = await readMemoryIndexes(directories)
    expect(indexes[0]?.wholeFile).toBe(true)
  })

  it('reports a directory it cannot read instead of staying quiet', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await mkdir(join(directories.project, 'MEMORY.md'), { recursive: true })

    const { indexes, problems } = await readMemoryIndexes(directories)
    expect(indexes).toEqual([])
    expect(problems).toEqual([])
  })
})

describe('LoadMemoryHook', () => {
  it('creates the directories and drafts a context event per index', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    const hook = new LoadMemoryHook({ directories })

    const empty = await hook.run({ threadId: toThreadId('t1'), projectDirectory: '/anywhere' })
    expect(empty.drafts).toBeUndefined()

    await writeFile(join(directories.project, 'MEMORY.md'), '- [Bun](bun.md) — deflate is raw')
    const loaded = await hook.run({ threadId: toThreadId('t1'), projectDirectory: '/anywhere' })

    expect(loaded.drafts).toHaveLength(1)
    const draft = loaded.drafts?.[0]
    expect(draft?.type).toBe('context-loaded')
    expect(draft && 'slot' in draft ? draft.slot : undefined).toBe(EContextSlot.Memory)
  })

  it('records each injected index as seen by the thread, partial when bounded', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    await writeFile(join(directories.user, 'MEMORY.md'), '- [Who](who.md) — a person')
    const long = Array.from({ length: MAX_INDEX_LINES + 50 }, (_, at) => `- entry ${at}`).join('\n')
    await writeFile(join(directories.project, 'MEMORY.md'), long)

    const readState = new InMemoryFileReadState()
    const hook = new LoadMemoryHook({ directories, readState })
    await hook.run({ threadId: toThreadId('t1'), projectDirectory: '/anywhere' })

    expect(
      readState.viewOf({ threadId: toThreadId('t1'), path: join(directories.user, 'MEMORY.md') })
        ?.wholeFile,
    ).toBe(true)
    expect(
      readState.viewOf({ threadId: toThreadId('t1'), path: join(directories.project, 'MEMORY.md') })
        ?.wholeFile,
    ).toBe(false)
  })

  it('ignores the worktree path it is handed', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    await writeFile(join(directories.project, 'MEMORY.md'), '- [One](one.md) — a hook')

    const hook = new LoadMemoryHook({ directories })
    const fromRoot = await hook.run({ threadId: toThreadId('t'), projectDirectory: '/repo' })
    const fromWorktree = await hook.run({
      threadId: toThreadId('t'),
      projectDirectory: '/repo/.claude/worktrees/eng-1',
    })

    const keyOf = (result: Awaited<ReturnType<typeof hook.run>>): unknown => {
      const draft = result.drafts?.[0]
      return draft && 'key' in draft ? draft.key : undefined
    }
    expect(keyOf(fromWorktree)).toBe(keyOf(fromRoot))
  })
})

describe('the memory hook through the resolved hook chain', () => {
  it('is picked up by resolveHookChain and yields its drafts from beforeTurn', async () => {
    const home = await scratch()
    const directories = directoriesIn(home)
    await ensureMemoryDirectories(directories)
    await writeFile(join(directories.project, 'MEMORY.md'), '- [Bun](bun.md) — deflate is raw')

    const container = createIsolatedContainer()
    container.register(portToken(BeforeTurnHook), {
      useValue: new LoadMemoryHook({ directories }),
    })

    const chain = resolveHookChain({ container })
    const drafts = await chain.beforeTurn({
      threadId: toThreadId('t1'),
      projectDirectory: '/repo/.claude/worktrees/eng-1',
    })

    expect(drafts).toHaveLength(1)
    const draft = drafts[0]
    expect(draft?.type).toBe('context-loaded')
    expect(draft && 'key' in draft ? draft.key : undefined).toBe(
      join(directories.project, 'MEMORY.md'),
    )
    expect(draft && 'content' in draft ? draft.content : '').toContain('deflate is raw')
  })
})
