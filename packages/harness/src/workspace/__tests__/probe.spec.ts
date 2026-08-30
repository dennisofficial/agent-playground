import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeWorkspace } from '../probe'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-workspace-')))
  made.push(path)
  return path
}

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const status = await proc.exited
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

const repoWithCommit = async (): Promise<string> => {
  const root = await scratch()
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  return root
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('probeWorkspace', () => {
  it('reports the repo root from a subdirectory, not the subdirectory', async () => {
    const root = await repoWithCommit()
    const nested = join(root, 'apps', 'tui')
    await mkdir(nested, { recursive: true })

    expect(await probeWorkspace({ cwd: nested })).toEqual({ workspace: root, repo: root })
  })

  it('gives a linked worktree its own workspace while naming the repo it came from', async () => {
    const root = await repoWithCommit()
    const linked = join(await scratch(), 'feature')
    await git(['worktree', 'add', linked, '-b', 'feature'], root)

    const identity = await probeWorkspace({ cwd: linked })

    expect(identity.workspace).toBe(await realpath(linked))
    expect(identity.repo).toBe(root)
    expect(identity.workspace).not.toBe(identity.repo)
  })

  it('falls back to the directory itself outside a repo', async () => {
    const loose = await scratch()

    expect(await probeWorkspace({ cwd: loose })).toEqual({ workspace: loose, repo: null })
  })

  it('does not claim a nested directory for a parent that is not a repo', async () => {
    const loose = await scratch()
    const nested = join(loose, 'documents', 'work')
    await mkdir(nested, { recursive: true })

    expect((await probeWorkspace({ cwd: nested })).workspace).toBe(nested)
  })

  it('resolves a path that does not exist to itself rather than throwing', async () => {
    const missing = join(await scratch(), 'gone')

    expect((await probeWorkspace({ cwd: missing })).workspace).toBe(missing)
  })
})
