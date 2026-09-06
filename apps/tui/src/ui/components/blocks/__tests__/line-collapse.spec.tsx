import { testRender } from '@opentui/react/test-utils'
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import React from 'react'

import { toCallId } from '@dltech/atlas-core'

import { ECallState, type ToolCall } from '../../../../store'
import { EDetail } from '../../../../store/tools'
import { frameSettled } from '../../../__tests__/waiting'
import { grammarsReady, settle, teardown } from '../../../markdown/__tests__/harness'
import { styledLines } from '../../../markdown/__tests__/streamed-corpus'
import { ToolDetail } from '../tool-detail'

/**
 * Pixel fixtures for the one-renderable-per-line collapse of CodeLines, CommandRows and the
 * tool-detail line blocks. Recorded from the per-line row-<box> implementation; rerun with
 * RECORD_LINE_FIXTURES=1 only when a deliberate visual change lands.
 *
 * Each entry is captured in both states of the async highlight: plain (the tree-sitter pass has
 * not answered) and settled (the same cells, coloured). The plain capture polls the raw buffer
 * from the moment of mount with bare macrotask yields: the first frame draws at hop ~2 while the
 * highlight's worker round trip lands around hop ~28 even with a warm worker, so the margin is
 * structural rather than a wall-clock race. A lost race fails loudly, because a highlighted
 * scenario's plain capture must differ from its settled one.
 */

await grammarsReady()

const FIXTURE = join(import.meta.dir, 'fixtures', 'line-collapse.json')

const HEIGHT = 44

const WIDTHS = [40, 80, 120] as const

const CWD = '/repo'

let ordinal = 0

const call = (args: {
  name: string
  input?: unknown
  output?: unknown
  state?: ECallState
  note?: string
}): ToolCall => {
  ordinal += 1
  return {
    callId: toCallId(`line-collapse-${ordinal}`),
    name: args.name,
    input: args.input ?? {},
    output: args.output,
    modelText: '',
    state: args.state ?? ECallState.Ok,
    note: args.note ?? null,
    at: null,
    settledAt: '2026-08-29T00:00:00.000Z',
  }
}

const numbered = (from: number, lines: readonly string[]): string =>
  lines.map((line, index) => `${from + index}\t${line}`).join('\n')

const readCall = (args: { file: string; from: number; lines: readonly string[] }): ToolCall =>
  call({
    name: 'read',
    input: { path: `${CWD}/src/${args.file}` },
    output: { path: `${CWD}/src/${args.file}`, text: numbered(args.from, args.lines) },
  })

/**
 * The highlight cache is process-wide, so a settled capture at one width would warm the plain
 * capture at the next. Every highlighted corpus ends in a width-stamped line to keep each
 * (scenario, width) pair's cache key its own.
 */
const stamped = (lines: readonly string[], width: number): readonly string[] => [
  ...lines,
  `const paneWidth = ${width}`,
]

const TS_SHORT = [
  "import { readFileSync } from 'node:fs'",
  '',
  'export function load(name: string): string {',
  "  return readFileSync(name, 'utf8')",
  '}',
]

const TS_EDGE = [
  'const narrow = 1',
  'a line the read tool never numbered',
  '2\t',
  '\tconst tabbed = true',
  'const wide = "界界界界界界界界界界"',
  'const emoji = "🙂🙂🙂 and more"',
  `const long = '${'x'.repeat(180)}'`,
]

const CALLS: Record<string, (width: number) => ToolCall> = {
  'read-1digit': (width) =>
    readCall({ file: `one-digit-${width}.ts`, from: 1, lines: stamped(TS_SHORT, width) }),
  'read-2digit': (width) =>
    readCall({
      file: `two-digit-${width}.ts`,
      from: 8,
      lines: stamped([...TS_SHORT, ...TS_SHORT, 'const extra = 2'], width),
    }),
  'read-3digit': (width) =>
    readCall({
      file: `three-digit-${width}.ts`,
      from: 98,
      lines: stamped([...TS_SHORT, 'const over = 100', 'const hundred = 101'], width),
    }),
  'read-edge': (width) => readCall({ file: `edge-${width}.ts`, from: 41, lines: stamped(TS_EDGE, width) }),
  'created-file': (width) =>
    call({
      name: 'write',
      input: {
        path: `${CWD}/src/fresh-${width}.ts`,
        content: [
          ...TS_SHORT,
          `const paneWidth = ${width}`,
          '\tconst indented = 1',
          `const long = '${'y'.repeat(150)}'`,
          ...Array.from({ length: 15 }, (_u, index) => `export const row${index} = ${index}`),
        ].join('\n'),
      },
      output: { path: `${CWD}/src/fresh-${width}.ts`, created: true, bytes: 812 },
    }),
  'terminal-multi': (width) =>
    call({
      name: 'bash',
      input: {
        command: `bun run build \\\n\t--filter @dltech/atlas \\\n  --outdir ${'d'.repeat(100)}\necho pane-${width}`,
        description: 'Build the workspace',
      },
      output: {
        command: '…',
        stdout: [
          'bundled 3 entry points',
          '\x1b[31merror-ish coloured output\x1b[0m follows',
          `wrote ${'o'.repeat(150)}`,
          '界 unicode output row',
          ...Array.from({ length: 12 }, (_u, index) => `step ${index + 1} done`),
        ].join('\n'),
        exitCode: 0,
      },
    }),
  'detail-output': () =>
    call({
    name: 'bash',
    input: { command: 'bun test --bail', description: 'Run the suite' },
    output: {
      stdout: [
        'first line of output',
        `a ${'very '.repeat(30)}long line`,
        '界 wide output',
        ...Array.from({ length: 13 }, (_u, index) => `out ${index + 1}`),
      ].join('\n'),
        exitCode: 0,
      },
    }),
  'detail-matches': () =>
    call({
      name: 'grep',
    input: { pattern: 'useStyledRows' },
    output: {
      matches: [
        'src/ui/components/blocks/tool-code-lines.ts:68:export function useStyledRows(args: {',
        'short.ts:7:const x: number = 1',
        `a/very/long/path/that/keeps/going/until/it/must/be/clipped/${'deep/'.repeat(8)}file.ts:123: match: with: colons`,
        ...Array.from(
          { length: 12 },
          (_u, index) => `src/more/${index}.ts:${index + 1}: hit ${index}`,
        ),
      ],
      },
    }),
  'detail-paths': () =>
    call({
      name: 'glob',
    input: { pattern: '**/*.ts' },
    output: {
      paths: [
        `${CWD}/src/ui/theme.ts`,
        `${CWD}/src/ui/${'nested/'.repeat(12)}far-too-long-to-fit.ts`,
        ...Array.from({ length: 13 }, (_u, index) => `${CWD}/src/leaf-${index}.ts`),
      ],
      },
    }),
  'detail-reason': () =>
    call({
      name: 'write',
    input: { path: `${CWD}/outside.ts` },
    state: ECallState.Denied,
      note: 'the path is outside the workspace root, and this sentence keeps going long enough to wrap onto a second and third row even at a comfortable width',
    }),
  'detail-tests': () =>
    call({
      name: 'bash',
    input: { command: 'bun test' },
    output: {
      stdout: [
        '(fail) src/a.spec.ts > renders the thing',
        '(fail) src/b.spec.ts > handles a tab\tin the name',
        ' 41 pass',
        ' 2 fail',
      ].join('\n'),
        exitCode: 1,
      },
    }),
}

const DETAILS: Record<string, EDetail> = {
  'read-1digit': EDetail.File,
  'read-2digit': EDetail.File,
  'read-3digit': EDetail.File,
  'read-edge': EDetail.File,
  'created-file': EDetail.Created,
  'terminal-multi': EDetail.Terminal,
  'detail-output': EDetail.Output,
  'detail-matches': EDetail.Matches,
  'detail-paths': EDetail.Paths,
  'detail-reason': EDetail.Reason,
  'detail-tests': EDetail.Tests,
}

type Capture = { chars: string; spans: readonly string[] }

type Entry = { plain: Capture; settled: Capture }

const recording = process.env.RECORD_LINE_FIXTURES === '1'

const fixture: Record<string, Entry> = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Entry>)
  : {}

const recorded: Record<string, Entry> = {}

afterAll(() => {
  if (!recording) return
  mkdirSync(dirname(FIXTURE), { recursive: true })
  writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`)
})

type Setup = Awaited<ReturnType<typeof testRender>>

const capture = (setup: Setup): Capture => ({
  chars: setup.captureCharFrame(),
  spans: styledLines(setup.captureSpans()),
})

const SENTINELS: Record<string, string> = {
  'read-1digit': 'readFileSync',
  'read-2digit': 'readFileSync',
  'read-3digit': 'readFileSync',
  'read-edge': 'const narrow',
  'created-file': 'readFileSync',
  'terminal-multi': 'bun run build',
  'detail-output': 'first line of output',
  'detail-matches': ':68',
  'detail-paths': 'theme.ts',
  'detail-reason': 'workspace root',
  'detail-tests': 'renders the thing',
}

const HIGHLIGHTED = new Set([
  'read-1digit',
  'read-2digit',
  'read-3digit',
  'read-edge',
  'created-file',
  'terminal-multi',
])

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function nodeFor(args: { name: string; width: number }): React.ReactNode {
  const detail = DETAILS[args.name] ?? EDetail.None
  const build = CALLS[args.name] ?? CALLS['read-1digit']
  if (build === undefined) return null
  return <ToolDetail detail={detail} call={build(args.width)} inner={args.width - 6} cwd={CWD} />
}

async function capturePlain(args: { name: string; width: number }): Promise<Capture> {
  const sentinel = SENTINELS[args.name] ?? ''
  const setup = await testRender(nodeFor(args), { width: args.width, height: HEIGHT })
  try {
    for (let hop = 0; hop < 4000; hop += 1) {
      if (setup.captureCharFrame().includes(sentinel)) return capture(setup)
      await tick()
    }
    throw new Error(`${args.name}@${args.width}: never drew ${JSON.stringify(sentinel)}`)
  } finally {
    await teardown(setup)
  }
}

async function captureSettled(args: { name: string; width: number }): Promise<Capture> {
  const setup = await testRender(nodeFor(args), { width: args.width, height: HEIGHT })
  try {
    await settle()
    await frameSettled({ setup, within: 3000 })
    return capture(setup)
  } finally {
    await teardown(setup)
  }
}

describe('line blocks draw the same cells before and after the collapse', () => {
  for (const name of Object.keys(CALLS)) {
    for (const width of WIDTHS) {
      it(`${name} at ${width}, plain and settled`, async () => {
        const plain = await capturePlain({ name, width })
        const settled = await captureSettled({ name, width })
        if (HIGHLIGHTED.has(name)) {
          expect(plain, `${name}@${width} plain capture was already coloured`).not.toEqual(settled)
        }
        if (recording) {
          recorded[`${name}@${width}`] = { plain, settled }
          return
        }
        const expected = fixture[`${name}@${width}`]
        if (expected === undefined) throw new Error(`no fixture for ${name}@${width}`)
        expect({ plain, settled }).toEqual(expected)
      })
    }
  }
})
