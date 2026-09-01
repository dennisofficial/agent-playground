import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EForge } from '../pure'

import { probeCheckout } from '../checkout-probe'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-forge-')))
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

describe('probeCheckout', () => {
  it('reads the branch and the origin remote off a real checkout', async () => {
    const root = await repoWithCommit()
    await git(['remote', 'add', 'origin', 'git@github.com:o/r.git'], root)

    expect(await probeCheckout({ directory: root })).toEqual({
      directory: root,
      branch: 'main',
      forge: EForge.GitHub,
      remote: { host: 'github.com', owner: 'o', repo: 'r' },
    })
  })

  it('prefers origin over the other remotes git reports', async () => {
    const root = await repoWithCommit()
    await git(['remote', 'add', 'upstream', 'git@github.com:upstream-owner/r.git'], root)
    await git(['remote', 'add', 'origin', 'git@github.com:o/r.git'], root)

    expect((await probeCheckout({ directory: root }))?.remote.owner).toBe('o')
  })

  it('is null on a detached head, before gh is ever asked', async () => {
    const root = await repoWithCommit()
    await git(['remote', 'add', 'origin', 'git@github.com:o/r.git'], root)
    await git(['checkout', '--detach'], root)

    expect(await probeCheckout({ directory: root })).toBeNull()
  })

  it('is null with no remotes at all', async () => {
    expect(await probeCheckout({ directory: await repoWithCommit() })).toBeNull()
  })

  it('is null outside a repository', async () => {
    expect(await probeCheckout({ directory: await scratch() })).toBeNull()
  })

  it('reads the linked worktree branch, not the one the main checkout is on', async () => {
    const root = await repoWithCommit()
    await git(['remote', 'add', 'origin', 'git@github.com:o/r.git'], root)
    const linked = join(root, 'wt')
    await git(['worktree', 'add', linked, '-b', 'feature-x'], root)

    const checkout = await probeCheckout({ directory: linked })

    expect(checkout?.branch).toBe('feature-x')
    expect(checkout?.remote).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
  })
})
