import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EContextSlot } from '@dltech/atlas-core'
import { FileBrowser, MAX_MENTION_BYTES } from '@dltech/atlas-harness'
import { beforeEach, describe, expect, it } from 'bun:test'

import { mentionedFileDrafts, workspaceFileLoader } from '../mentioned-files'

let root: string

const write = ({ at, content }: { at: string; content: string }): void => {
  const path = join(root, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const draftsFor = (text: string): Promise<readonly unknown[]> =>
  mentionedFileDrafts({
    text,
    load: workspaceFileLoader(new FileBrowser({ root })),
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-mentions-'))
})

describe('mentionedFileDrafts', () => {
  it('attaches nothing when nothing was mentioned', async () => {
    expect(await draftsFor('fix the build')).toEqual([])
  })

  it('attaches a mentioned file as loaded context', async () => {
    write({ at: 'src/app.ts', content: 'export const app = 1\n' })

    expect(await draftsFor('why is @src/app.ts broken')).toEqual([
      {
        type: 'context-loaded',
        slot: EContextSlot.File,
        key: 'src/app.ts',
        content: 'export const app = 1\n',
      },
    ])
  })

  it('attaches each file named, in the order they were named', async () => {
    write({ at: 'a.ts', content: 'a' })
    write({ at: 'b.ts', content: 'b' })

    const drafts = await draftsFor('compare @b.ts with @a.ts')
    expect(drafts.map((draft) => (draft as { key: string }).key)).toEqual(['b.ts', 'a.ts'])
  })

  it('attaches a directory as its listing', async () => {
    write({ at: 'pkg/one.ts', content: 'x' })

    const drafts = await draftsFor('look through @pkg/')
    expect(drafts).toHaveLength(1)
    expect((drafts[0] as { content: string }).content).toBe('pkg/ is a directory holding:\n\none.ts')
  })

  it('says so when a file was too large to attach whole', async () => {
    write({ at: 'big.txt', content: 'a'.repeat(MAX_MENTION_BYTES + 10) })

    const drafts = await draftsFor('read @big.txt')
    expect((drafts[0] as { content: string }).content).toContain('was too large to attach whole')
  })

  it('stays quiet about something that is not a file', async () => {
    expect(await draftsFor('the @injectable() decorator')).toEqual([])
  })

  it('attaches a file outside the workspace, because that is the point', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'atlas-elsewhere-'))
    writeFileSync(join(elsewhere, 'notes.md'), 'borrowed')

    const drafts = await draftsFor(`read @${join(elsewhere, 'notes.md')}`)
    expect((drafts[0] as { content: string }).content).toBe('borrowed')
  })
})
