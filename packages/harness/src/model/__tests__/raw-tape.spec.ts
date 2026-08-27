import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRawTape, NO_RAW_TAPE, RAW_TAPE_ENVIRONMENT_VARIABLE } from '../raw-tape'

const enabled = { [RAW_TAPE_ENVIRONMENT_VARIABLE]: '1' }

const roots: string[] = []

const makeDirectory = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'atlas-raw-tape-'))
  roots.push(root)
  return join(root, 'tapes')
}

const tapeFiles = (directory: string): readonly string[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()

const linesIn = (directory: string, name: string): readonly string[] =>
  readFileSync(join(directory, name), 'utf8').trimEnd().split('\n')

const soleLines = (directory: string): readonly string[] => {
  const files = tapeFiles(directory)
  expect(files.length).toBe(1)
  return linesIn(directory, files[0] ?? '')
}

const lastLineIn = (directory: string, name: string): unknown =>
  JSON.parse(linesIn(directory, name).at(-1) ?? '')

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true })
})

describe('createRawTape', () => {
  it('appends one line per part, in order', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory })

    tape.tap({ type: 'text-delta', text: 'one' })
    tape.tap({ type: 'text-delta', text: 'two' })
    tape.tap({ type: 'finish', usage: { inputTokens: 3 } })
    await tape.close()

    expect(soleLines(directory).slice(0, 3).map((line) => JSON.parse(line))).toEqual([
      { type: 'text-delta', text: 'one' },
      { type: 'text-delta', text: 'two' },
      { type: 'finish', usage: { inputTokens: 3 } },
    ])
  })

  it('keeps the scope in the file name so sessions are told apart', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_abc', env: enabled, directory })

    tape.tap({ type: 'start' })
    await tape.close()

    expect(tapeFiles(directory)[0]).toContain('session_abc')
  })

  it('writes nothing and creates no directory when the gate is unset', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: {}, directory })

    expect(tape).toBe(NO_RAW_TAPE)
    tape.tap({ type: 'text-delta', text: 'one' })
    await tape.close()

    expect(existsSync(directory)).toBe(false)
  })

  it('stays off for a value that is not an opt-in', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({
      scope: 'session_1',
      env: { [RAW_TAPE_ENVIRONMENT_VARIABLE]: '0' },
      directory,
    })

    tape.tap({ type: 'start' })
    await tape.close()

    expect(existsSync(directory)).toBe(false)
  })

  it('swallows a write that cannot land', async () => {
    const directory = makeDirectory()
    const blocked = join(directory, '..', 'blocked')
    writeFileSync(blocked, 'not a directory')
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory: join(blocked, 'x') })

    expect(() => tape.tap({ type: 'start' })).not.toThrow()
    expect(await tape.close()).toBeUndefined()
  })

  it('records a part that JSON.stringify refuses, rather than dropping it', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory })

    const circular: Record<string, unknown> = { type: 'tool-call' }
    circular.self = circular

    tape.tap(circular)
    tape.tap({ type: 'finish', totalTokens: 10n })
    tape.tap({
      type: 'error',
      toJSON: () => {
        throw new Error('refuses to serialise')
      },
    })
    tape.tap(undefined)
    await tape.close()

    const lines = soleLines(directory).map((line) => JSON.parse(line))

    expect(lines[0]).toEqual({ type: 'tool-call', self: '[circular]' })
    expect(lines[1]).toEqual({ type: 'finish', totalTokens: '10' })
    expect(lines[2]).toMatchObject({ atlasRawTape: 'unserialisable' })
    expect(lines[3]).toMatchObject({ atlasRawTape: 'unserialisable' })
  })
})

describe('a tape that ends', () => {
  it('marks a clean close as the last line', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory })

    tape.tap({ type: 'start' })
    await tape.close()

    expect(JSON.parse(soleLines(directory).at(-1) ?? '')).toEqual({ atlasRawTape: 'closed' })
  })

  it('leaves no file at all when nothing was ever tapped', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory })

    await tape.close()

    expect(existsSync(directory)).toBe(false)
  })

  it('ignores parts tapped after it closed, and closes twice without a second marker', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory })

    tape.tap({ type: 'start' })
    await tape.close()
    tape.tap({ type: 'text-delta', text: 'too late' })
    await tape.close()

    expect(soleLines(directory)).toEqual(['{"type":"start"}', '{"atlasRawTape":"closed"}'])
  })
})

describe('a tape that fills a segment', () => {
  const fill = async (args: { directory: string; parts: number; segmentBytes: number }) => {
    const tape = createRawTape({
      scope: 'session_1',
      env: enabled,
      directory: args.directory,
      segmentBytes: args.segmentBytes,
    })
    for (let index = 0; index < args.parts; index += 1) {
      tape.tap({ type: 'text-delta', text: `delta number ${index}` })
    }
    await tape.close()
  }

  it('rotates into a new segment instead of going silent', async () => {
    const directory = makeDirectory()
    await fill({ directory, parts: 40, segmentBytes: 200 })

    const files = tapeFiles(directory)
    expect(files.length).toBeGreaterThan(3)

    const deltas = files
      .flatMap((name) => linesIn(directory, name))
      .map((line) => JSON.parse(line))
      .filter((line): line is { text: string } => 'text' in line)

    expect(deltas.length).toBe(40)
    expect(deltas[0]?.text).toBe('delta number 0')
    expect(deltas.at(-1)?.text).toBe('delta number 39')
  })

  it('ends a rotated segment with a marker naming the next one', async () => {
    const directory = makeDirectory()
    await fill({ directory, parts: 40, segmentBytes: 200 })

    const files = tapeFiles(directory)
    expect(lastLineIn(directory, files[0] ?? '')).toEqual({
      atlasRawTape: 'rotated',
      next: files[1],
    })
  })

  it('closes the final segment with the close marker, not a rotation marker', async () => {
    const directory = makeDirectory()
    await fill({ directory, parts: 40, segmentBytes: 200 })

    const files = tapeFiles(directory)
    expect(lastLineIn(directory, files.at(-1) ?? '')).toEqual({ atlasRawTape: 'closed' })
    for (const name of files.slice(0, -1)) {
      expect(lastLineIn(directory, name)).toMatchObject({ atlasRawTape: 'rotated' })
    }
  })

  it('keeps a single part larger than a segment rather than losing it', async () => {
    const directory = makeDirectory()
    const tape = createRawTape({ scope: 'session_1', env: enabled, directory, segmentBytes: 20 })

    tape.tap({ type: 'text-delta', text: 'x'.repeat(500) })
    await tape.close()

    expect(JSON.parse(tapeFiles(directory).flatMap((n) => linesIn(directory, n))[0] ?? '')).toEqual({
      type: 'text-delta',
      text: 'x'.repeat(500),
    })
  })
})

describe('the tape directory budget', () => {
  const session = async (args: {
    directory: string
    scope: string
    maximumFiles?: number
    maximumDirectoryBytes?: number
  }) => {
    const tape = createRawTape({
      scope: args.scope,
      env: enabled,
      directory: args.directory,
      segmentBytes: 64,
      ...(args.maximumFiles === undefined ? {} : { maximumFiles: args.maximumFiles }),
      ...(args.maximumDirectoryBytes === undefined
        ? {}
        : { maximumDirectoryBytes: args.maximumDirectoryBytes }),
    })
    tape.tap({ type: 'start' })
    await tape.close()
  }

  it('evicts the oldest tapes once the file count is reached', async () => {
    const directory = makeDirectory()
    for (const scope of ['one', 'two', 'three', 'four', 'five']) {
      await session({ directory, scope, maximumFiles: 99 })
    }

    await session({ directory, scope: 'newest', maximumFiles: 3 })

    const remaining = tapeFiles(directory)
    expect(remaining.length).toBe(3)
    expect(remaining.some((name) => name.includes('newest'))).toBe(true)
  })

  it('evicts the oldest tapes once the byte budget is reached', async () => {
    const directory = makeDirectory()
    for (const scope of ['one', 'two', 'three', 'four', 'five']) {
      await session({ directory, scope, maximumDirectoryBytes: 1024 * 1024 })
    }

    await session({ directory, scope: 'newest', maximumDirectoryBytes: 200 })

    const remaining = tapeFiles(directory)
    const bytes = remaining.reduce(
      (total, name) => total + statSync(join(directory, name)).size,
      0,
    )

    expect(remaining.length).toBeLessThan(6)
    expect(bytes).toBeLessThanOrEqual(200)
    expect(remaining.some((name) => name.includes('newest'))).toBe(true)
  })
})

describe('NO_RAW_TAPE', () => {
  it('takes a part and a close without touching the disk', async () => {
    expect(() => NO_RAW_TAPE.tap({ type: 'start' })).not.toThrow()
    expect(await NO_RAW_TAPE.close()).toBeUndefined()
  })
})
