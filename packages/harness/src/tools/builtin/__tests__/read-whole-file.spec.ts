import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { ReadTool } from '../read'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-read-'))
  await writeFile(join(root, 'many.txt'), 'alpha\nbravo\ncharlie\ndelta\n')
  await writeFile(join(root, 'one.txt'), 'solo\n')
  await writeFile(join(root, 'empty.txt'), '')
})

const tool = new ReadTool()

const readWith = async (input: { path: string; offset?: number; limit?: number }) => {
  const outcome = await tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'read-1',
  })

  if (!outcome.ok) throw new Error(outcome.reason)

  const output = outcome.output as { truncated: boolean }
  return { claimsWhole: tool.revealsWholeFile?.(input) ?? false, truncated: output.truncated }
}

describe('ReadTool.revealsWholeFile against what the read actually returned', () => {
  const windows = [
    { name: 'no window', input: {} },
    { name: 'an offset', input: { offset: 2 } },
    { name: 'a limit shorter than the file', input: { limit: 2 } },
    { name: 'a limit longer than the file', input: { limit: 1000 } },
    { name: 'an offset and a limit', input: { offset: 2, limit: 1 } },
  ]

  for (const file of ['many.txt', 'one.txt', 'empty.txt']) {
    for (const window of windows) {
      it(`never claims the whole of ${file} through ${window.name} when the read was truncated`, async () => {
        const { claimsWhole, truncated } = await readWith({ path: join(root, file), ...window.input })
        if (claimsWhole) expect(truncated).toBe(false)
      })
    }
  }

  it('claims the whole file when asked for it without a window', async () => {
    expect(await readWith({ path: join(root, 'many.txt') })).toEqual({
      claimsWhole: true,
      truncated: false,
    })
  })

  it('claims the whole of an empty file, which reads as past its end', async () => {
    expect(await readWith({ path: join(root, 'empty.txt') })).toEqual({
      claimsWhole: true,
      truncated: false,
    })
  })

  it('declines to claim a whole file that a generous limit happened to return in full', async () => {
    expect(await readWith({ path: join(root, 'many.txt'), limit: 1000 })).toEqual({
      claimsWhole: false,
      truncated: false,
    })
  })
})
