import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { LocalFileSystemPort } from '../../../execution/local-filesystem'
import { LocalProcessPort } from '../../../execution/local-process'
import { GrepTool } from '../grep'

class WithoutRipgrep extends LocalProcessPort {
  override which(): string | null {
    return null
  }
}

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-grep-symlinks-'))
  await mkdir(join(root, 'real', 'sub'), { recursive: true })
  await writeFile(join(root, 'real', 'a.txt'), 'needle in a\n')
  await writeFile(join(root, 'real', 'sub', 'b.txt'), 'needle in b\n')
  await writeFile(join(root, 'real', 'notes.md'), 'needle in md\n')
  await symlink(join(root, 'real'), join(root, 'linked'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const grep = async (input: unknown): Promise<ToolOutcome> =>
  new GrepTool(new WithoutRipgrep(), new LocalFileSystemPort()).invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'grep-symlinks',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const matchesIn = async (input: unknown): Promise<readonly string[]> => {
  const outcome = await grep(input)
  if (!outcome.ok) throw new Error(outcome.reason)
  return (outcome.output as { matches: readonly string[] }).matches
}

describe('GrepTool fallback through symlinks', () => {
  it('finds matches inside a symlinked directory reached from the search root', async () => {
    const matches = await matchesIn({ pattern: 'needle' })

    expect(matches.some((line) => line.includes('a.txt:1:needle in a'))).toBe(true)
    expect(matches.some((line) => line.includes(join('sub', 'b.txt') + ':1:needle in b'))).toBe(true)
  })

  it('follows a symlink handed to it as the search path', async () => {
    const matches = await matchesIn({ pattern: 'needle', path: join(root, 'linked') })

    expect(matches.some((line) => line.includes('a.txt:1:needle in a'))).toBe(true)
  })

  it('narrows by glob while following links', async () => {
    const matches = await matchesIn({ pattern: 'needle', glob: '*.md' })

    expect(matches).toHaveLength(1)
    expect(matches[0]).toContain('notes.md:1:needle in md')
  })

  it('survives a symlink cycle under the search root', async () => {
    await symlink(join(root, 'real'), join(root, 'real', 'self'))

    const matches = await matchesIn({ pattern: 'needle' })

    expect(matches.length).toBeGreaterThan(0)
  })

  it('never reports the same file twice when a link and the real path both lead to it', async () => {
    const matches = await matchesIn({ pattern: 'needle in a' })

    expect(matches).toHaveLength(1)
    expect(matches[0]).toContain(join(root, 'real', 'a.txt'))
  })
})
