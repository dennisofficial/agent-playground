import { toThreadId } from '@dltech/atlas-core'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { ReadTool } from '../read'

const SESSION_DIRECTORY = '/workspace'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-read-'))
  await writeFile(join(root, 'many.txt'), 'alpha\nbravo\ncharlie\ndelta\n')
  await writeFile(join(root, 'one.txt'), 'solo\n')
  await writeFile(join(root, 'empty.txt'), '')
  await writeFile(
    join(root, 'long.txt'),
    `${Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join('\n')}\n`,
  )
  await writeFile(join(root, 'wide.txt'), `${'x'.repeat(5_000)}\nshort\n`)
})

const tool = new ReadTool()

const readWith = async (input: { path: string; offset?: number; limit?: number }) => {
  const outcome = await tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'read-1',
    projectDirectory: SESSION_DIRECTORY,
    threadId: toThreadId('thread-1'),
  })

  if (!outcome.ok) throw new Error(outcome.reason)

  const output = outcome.output as { truncated: boolean }
  return {
    claimsWhole: tool.revealsWholeFile?.({ input, output: outcome.output }) ?? false,
    truncated: output.truncated,
  }
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

  it('declines to claim a file the default line limit cut short', async () => {
    expect(await readWith({ path: join(root, 'long.txt') })).toEqual({
      claimsWhole: false,
      truncated: true,
    })
  })

  it('declines to claim a file whose lines were clipped', async () => {
    expect(await readWith({ path: join(root, 'wide.txt') })).toEqual({
      claimsWhole: false,
      truncated: true,
    })
  })
})
