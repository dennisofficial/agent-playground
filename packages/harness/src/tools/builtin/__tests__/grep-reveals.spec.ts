import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'

import { GrepTool, type GrepInput } from '../grep'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-grep-reveals-'))

  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'top.ts'), 'const a = 1\nconst needle = 2\nconst b = 3\n')
  await writeFile(join(root, 'sub', 'deep.ts'), 'const c = 1\nconst needle = 4\n')
  await writeFile(join(root, 'sub', 'quiet.ts'), 'nothing to find here\n')
})

const tool = new GrepTool()

const search = async (input: GrepInput): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'grep-1',
    sessionDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const revealedBy = (outcome: ToolOutcome, input: GrepInput): readonly string[] => {
  expect(outcome.ok).toBe(true)
  return outcome.ok ? (tool.revealsLinesOf?.({ input, output: outcome.output }) ?? []) : []
}

describe('what a search tells the harness it showed', () => {
  it('names every file it printed a matching line from, and none it did not', async () => {
    const input = { pattern: 'needle' }

    expect([...revealedBy(await search(input), input)].sort()).toEqual([
      join(root, 'sub', 'deep.ts'),
      join(root, 'top.ts'),
    ])
  })

  it('names the file itself when the search was narrowed to one', async () => {
    const input = { pattern: 'needle', path: join(root, 'top.ts') }

    expect(revealedBy(await search(input), input)).toEqual([join(root, 'top.ts')])
  })

  it('names nothing when nothing matched', async () => {
    const input = { pattern: 'nowhere-in-this-tree' }

    expect(revealedBy(await search(input), input)).toEqual([])
  })

  it('names a file once however many of its lines matched', async () => {
    const input = { pattern: 'const' }

    expect(revealedBy(await search(input), input)).toContain(join(root, 'top.ts'))
    expect(
      revealedBy(await search(input), input).filter((path) => path === join(root, 'top.ts')),
    ).toHaveLength(1)
  })

  it('names only the files on the page it actually returned', async () => {
    const input = { pattern: 'const', headLimit: 1 }
    const revealed = revealedBy(await search(input), input)

    expect(revealed).toHaveLength(1)
    expect(revealed).not.toContain(join(root, 'sub', 'quiet.ts'))
  })

  it('names a file whose context lines were printed alongside its match, and not one without', async () => {
    const input = { pattern: 'needle', context: 1 }
    const revealed = revealedBy(await search(input), input)

    expect([...revealed].sort()).toEqual([join(root, 'sub', 'deep.ts'), join(root, 'top.ts')])
  })

  it('reports nothing from an output that is not its own', async () => {
    const input: GrepInput = { pattern: 'needle' }

    expect(tool.revealsLinesOf?.({ input, output: { matches: ['a'] } })).toEqual([])
    expect(tool.revealsLinesOf?.({ input, output: null })).toEqual([])
  })
})
