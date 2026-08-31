import { toThreadId } from '@dltech/atlas-core'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { ReadTool } from '../read'

const DEFAULT_LINE_LIMIT = 2_000
const MAX_LINE_CHARS = 2_000

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-read-limits-'))
  await writeFile(
    join(root, 'long.txt'),
    `${Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join('\n')}\n`,
  )
  await writeFile(join(root, 'minified.js'), `${'a'.repeat(400_000)}\n`)
  await writeFile(join(root, 'short.txt'), 'alpha\nbravo\n')
})

const tool = new ReadTool()

const read = async (input: { path: string; offset?: number; limit?: number }) => {
  const outcome = await tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'read-limits',
    sessionDirectory: '/workspace',
    threadId: toThreadId('thread-1'),
  })

  if (!outcome.ok) throw new Error(outcome.reason)

  const { lines, truncated } = outcome.output as { lines: number; truncated: boolean }
  return { text: outcome.modelText, output: { lines, truncated } }
}

describe('ReadTool caps what one read can cost', () => {
  it(`returns at most ${DEFAULT_LINE_LIMIT} lines when no limit is given`, async () => {
    const { output } = await read({ path: join(root, 'long.txt') })
    expect(output).toEqual({ lines: DEFAULT_LINE_LIMIT, truncated: true })
  })

  it('names the line to resume from when it stops early', async () => {
    const { text } = await read({ path: join(root, 'long.txt') })
    expect(text).toContain(`Stopped after ${DEFAULT_LINE_LIMIT} lines.`)
    expect(text).toContain(`offset ${DEFAULT_LINE_LIMIT + 1}`)
  })

  it('resumes exactly where it said to, with no line lost or repeated', async () => {
    const first = await read({ path: join(root, 'long.txt') })
    const second = await read({ path: join(root, 'long.txt'), offset: DEFAULT_LINE_LIMIT + 1 })

    expect(first.text.split('\n')[0]).toBe('1\tline 1')
    expect(second.text.split('\n')[0]).toBe(
      `${DEFAULT_LINE_LIMIT + 1}\tline ${DEFAULT_LINE_LIMIT + 1}`,
    )
    expect(second.output.lines).toBe(500)
  })

  it('reads a minified file by clipping the long line instead of refusing it', async () => {
    const { text, output } = await read({ path: join(root, 'minified.js') })

    expect(output.lines).toBe(1)
    expect(output.truncated).toBe(true)
    expect(text).toContain(`1 line ran past ${MAX_LINE_CHARS} characters and was clipped`)
    expect(text.split('\n')[0]?.length).toBe(`1\t`.length + MAX_LINE_CHARS)
  })

  it('says nothing extra when the whole file fits', async () => {
    const { text, output } = await read({ path: join(root, 'short.txt') })
    expect(text).toBe('1\talpha\n2\tbravo')
    expect(output).toEqual({ lines: 2, truncated: false })
  })

  it('honours an explicit limit below the default', async () => {
    const { output } = await read({ path: join(root, 'long.txt'), limit: 3 })
    expect(output).toEqual({ lines: 3, truncated: true })
  })
})
