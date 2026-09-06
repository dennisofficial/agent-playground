import { EDiffLine, sideBySideRows, type DiffFile, type DiffHunk } from '@dltech/atlas-core'
import type { CapturedFrame } from '@opentui/core'
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing'
import { createRoot } from '@opentui/react'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { grammarsReady, settle, teardown } from '../../../markdown/__tests__/harness'
import { InlineDiff } from '../inline-diff'
import { SideBySideDiff } from '../side-by-side-diff'
import { emphasiseNewCall, FILE, HUNK, LONG_LINE } from './fixtures'

const HEIGHT = 48

const WIDTHS = [40, 80, 120] as const

type SpanRecord = { text: string; fg: string; bg: string; attributes: number }

type CaseRecord = { chars: string; lines: SpanRecord[][] }

type Baseline = Record<string, CaseRecord>

const FIXTURE_URL = new URL('./render-baseline.json', import.meta.url)

const line = (args: {
  kind: EDiffLine
  old: number | null
  next: number | null
  text: string
  elided?: number
}) => ({
  kind: args.kind,
  oldNumber: args.old,
  newNumber: args.next,
  text: args.text,
  ...(args.elided === undefined ? {} : { elided: args.elided }),
})

const UNICODE_HUNK: DiffHunk = {
  heading: 'render',
  oldStart: 200,
  newStart: 200,
  lines: [
    line({ kind: EDiffLine.Context, old: 200, next: 200, text: '  render() {' }),
    line({ kind: EDiffLine.Removed, old: 201, next: null, text: '    const label = "plain"' }),
    line({
      kind: EDiffLine.Added,
      old: null,
      next: 201,
      text: '    const label = "héllo → wörld ✓"',
    }),
    line({ kind: EDiffLine.Added, old: null, next: 202, text: '\tconst indented = true' }),
    line({ kind: EDiffLine.Added, old: null, next: 203, text: LONG_LINE }),
    line({ kind: EDiffLine.Context, old: 202, next: 204, text: '  }' }),
  ],
}

const CORPUS: DiffFile = {
  ...FILE,
  hunks: [HUNK, UNICODE_HUNK],
}

const CORPUS_ROWS = CORPUS.hunks.map((hunk) => sideBySideRows(hunk))

function recordOf(args: { setup: TestRendererSetup }): CaseRecord {
  const frame: CapturedFrame = args.setup.captureSpans()
  return {
    chars: args.setup.captureCharFrame(),
    lines: frame.lines.map((row) =>
      row.spans.map((span) => ({
        text: span.text,
        fg: span.fg.toString(),
        bg: span.bg.toString(),
        attributes: span.attributes,
      })),
    ),
  }
}

async function mount(args: { width: number }): Promise<{
  setup: TestRendererSetup
  render: (node: React.ReactNode, width: number) => Promise<void>
}> {
  await grammarsReady()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const setup = await createTestRenderer({ width: args.width, height: HEIGHT })
  const root = createRoot(setup.renderer)
  const render = async (node: React.ReactNode, width: number): Promise<void> => {
    act(() => {
      root.render(
        <box flexDirection="column" width={width} height={HEIGHT}>
          {node}
        </box>,
      )
    })
    await act(async () => {
      await setup.flush()
      await settle()
    })
    await setup.flush()
  }
  return { setup, render }
}

async function capture(args: {
  node: (width: number) => React.ReactNode
  width: number
}): Promise<CaseRecord> {
  const { setup, render } = await mount({ width: args.width })
  try {
    await render(args.node(args.width), args.width)
    return recordOf({ setup })
  } finally {
    await teardown(setup)
  }
}

async function captureResize(args: {
  node: (width: number) => React.ReactNode
  from: number
  to: number
}): Promise<{ before: CaseRecord; after: CaseRecord }> {
  const { setup, render } = await mount({ width: args.from })
  try {
    await render(args.node(args.from), args.from)
    const before = recordOf({ setup })
    setup.resize(args.to, HEIGHT)
    await render(args.node(args.to), args.to)
    return { before, after: recordOf({ setup }) }
  } finally {
    await teardown(setup)
  }
}

async function readBaseline(): Promise<Baseline | null> {
  const file = Bun.file(FIXTURE_URL.pathname)
  if (!(await file.exists())) return null
  return (await file.json()) as Baseline
}

async function writeBaseline(baseline: Baseline): Promise<void> {
  await Bun.write(FIXTURE_URL.pathname, `${JSON.stringify(baseline, null, 2)}\n`)
}

const writing = process.env.DIFF_BASELINE_WRITE === '1'

const inline = (width: number) => <InlineDiff file={CORPUS} width={width} />

const sideBySide = (width: number) => (
  <SideBySideDiff file={CORPUS} rows={CORPUS_ROWS} width={width} />
)

describe('diff render baseline', () => {
  it('matches the recorded frames', async () => {
    const cases: Baseline = {}
    for (const width of WIDTHS) {
      cases[`inline-${width}`] = await capture({ node: inline, width })
    }
    cases['inline-emphasis-80'] = await capture({
      node: (width) => <InlineDiff file={CORPUS} width={width} emphasis={emphasiseNewCall} />,
      width: 80,
    })
    for (const width of WIDTHS) {
      cases[`side-by-side-${width}`] = await capture({ node: sideBySide, width })
    }
    const resized = await captureResize({ node: inline, from: 80, to: 120 })
    cases['inline-resize-before-80'] = resized.before
    cases['inline-resize-after-120'] = resized.after

    if (writing) {
      await writeBaseline(cases)
      return
    }

    const baseline = await readBaseline()
    if (baseline === null) {
      throw new Error('render-baseline.json missing; rerun with DIFF_BASELINE_WRITE=1')
    }
    for (const [name, record] of Object.entries(cases)) {
      const expected = baseline[name]
      if (expected === undefined) throw new Error(`no baseline recorded for ${name}`)
      expect(record, name).toEqual(expected)
    }
  }, 120_000)
})
