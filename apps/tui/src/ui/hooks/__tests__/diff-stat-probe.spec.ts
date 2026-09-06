import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import type { GitRun } from '@dltech/atlas-harness'

import { createDiffStatProbe, type GitRunner } from '../diff-stat-probe'

const ok = (stdout: string): GitRun => ({ ok: true, stdout, stderr: '' })
const failed = (stderr: string): GitRun => ({ ok: false, stdout: '', stderr })

const withoutHead: GitRunner = async ({ args }) => {
  if (args[0] === 'rev-parse') return failed('fatal: Needed a single revision')
  if (args.includes('HEAD')) return failed('fatal: ambiguous argument HEAD')
  if (args[0] === 'diff') return ok(' 1 file changed, 7 insertions(+)\n')
  return ok('')
}

describe('probeDiffStat on a repository without commits', () => {
  it('diffs against the empty tree when HEAD does not resolve', async () => {
    const probe = createDiffStatProbe({ run: withoutHead })

    expect(await probe({ directory: '/fresh/repo' })).toEqual({ added: 7, removed: 0 })
  })

  it('stays silent when HEAD exists but the diff fails for another reason', async () => {
    const probe = createDiffStatProbe({
      run: async ({ args }) => {
        if (args[0] === 'rev-parse') return ok('4aebaa53ac9ecaf0ab43cabbd43b8ded3a362ced\n')
        if (args.includes('HEAD')) return failed('fatal: unable to read tree')
        if (args[0] === 'diff') return ok(' 100 files changed, 9999 insertions(+)\n')
        return ok('')
      },
    })

    expect(await probe({ directory: '/broken/repo' })).toBeNull()
  })
})

describe('untracked line counting', () => {
  const cleanTreeWith = (untracked: string): GitRunner => async ({ args }) => {
    if (args[0] === 'ls-files') return ok(untracked)
    return ok('')
  }

  let directory: string | null = null
  afterEach(async () => {
    if (directory !== null) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('re-reads an untracked file only when its stat changed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'diff-stat-'))
    await writeFile(join(directory, 'a.txt'), 'one\ntwo\nthree\n')

    const reads: string[] = []
    const probe = createDiffStatProbe({
      run: cleanTreeWith('a.txt\0'),
      readText: async (path) => {
        reads.push(path)
        return await Bun.file(path).text()
      },
    })

    expect(await probe({ directory })).toEqual({ added: 3, removed: 0 })
    expect(await probe({ directory })).toEqual({ added: 3, removed: 0 })
    expect(reads).toHaveLength(1)

    await writeFile(join(directory, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    expect(await probe({ directory })).toEqual({ added: 4, removed: 0 })
    expect(reads).toHaveLength(2)
  })
})
