import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { toCallId } from '@dltech/atlas-core'

import { ECallState, type ToolCall, type ToolRun } from '../../store'
import { glyph } from '../theme'
import { ToolRunBlock } from '../components/blocks/tool-run-block'
import { teardown } from '../markdown/__tests__/harness'

const BULLET = glyph.block

const WIDTH = 100

const HEIGHT = 24

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
    callId: toCallId(`c${ordinal}`),
    name: args.name,
    input: args.input ?? {},
    output: args.output,
    modelText: '',
    state: args.state ?? ECallState.Ok,
    note: args.note ?? null,
    at: null,
    settledAt: args.state === ECallState.Pending ? null : '2026-08-29T00:00:00.000Z',
  }
}

const runOf = (calls: readonly ToolCall[]): ToolRun => ({
  key: 'tools:c1',
  openedBy: calls[0]?.callId ?? toCallId('c0'),
  calls,
})

async function frameOf(run: ToolRun, opened?: ReadonlySet<string>): Promise<string> {
  const setup = await testRender(
    <ToolRunBlock
      run={run}
      width={WIDTH}
      cwd={CWD}
      now={0}
      {...(opened === undefined ? {} : { opened })}
    />,
    { width: WIDTH, height: HEIGHT },
  )
  await setup.flush()
  const frame = setup.captureCharFrame()
  await teardown(setup)
  return frame
}

const read = (path: string, lines: number): ToolCall =>
  call({ name: 'read', input: { path: `${CWD}/${path}` }, output: { path: `${CWD}/${path}`, lines } })

describe('a run of tool calls in the transcript', () => {
  it('says what a stretch of gathering added up to', async () => {
    const frame = await frameOf(runOf([read('a.ts', 10), read('b.ts', 20)]))

    expect(frame).toContain('Read 2 files')
    expect(frame).toContain('30 lines')
  })

  it('draws a lone call as itself rather than counting to one', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'bash',
          input: { command: 'bun test', description: 'Wait for the full suite' },
          output: { command: 'bun test', stdout: '', exitCode: 0 },
        }),
      ]),
    )

    expect(frame).toContain('Wait for the full suite')
    expect(frame).not.toContain('ran 1 command')
  })

  it('keeps a named command in the place it actually happened', async () => {
    const frame = await frameOf(
      runOf([
        read('a.ts', 1),
        read('b.ts', 1),
        call({
          name: 'bash',
          input: { command: 'bunx tsc --noEmit' },
          output: { command: 'bunx tsc --noEmit', stdout: '', exitCode: 0 },
        }),
        read('c.ts', 1),
        read('d.ts', 1),
      ]),
    )
    const rows = frame.split('\n').filter((row) => row.trim().length > 0)
    const typecheck = rows.findIndex((row) => row.includes('Typecheck clean'))
    const sentences = rows.flatMap((row, index) => (row.includes('Read 2 files') ? [index] : []))

    expect(sentences).toHaveLength(2)
    expect(sentences[0]).toBeLessThan(typecheck)
    expect(sentences[1]).toBeGreaterThan(typecheck)
  })

  it('marks only the head of a cluster of quiet rows, and every loud one', async () => {
    const quiet = () =>
      call({
        name: 'bash',
        input: { command: 'bunx tsc --noEmit' },
        output: { command: 'bunx tsc --noEmit', stdout: '', exitCode: 0 },
      })
    const frame = await frameOf(runOf([quiet(), quiet(), quiet()]))
    const marks = frame.split('\n').filter((row) => row.includes(BULLET)).length

    expect(frame).toContain('Typecheck clean × 3')
    expect(marks).toBe(1)

    const mixed = await frameOf(
      runOf([
        quiet(),
        call({
          name: 'bash',
          input: { command: 'bun test' },
          output: { command: 'bun test', stdout: '\n 1 pass\n 3 fail\n', exitCode: 1 },
        }),
      ]),
    )

    // The second row failed, so it keeps its mark wherever it falls: that glyph is not saying
    // "tool", it is saying "this went wrong".
    expect(mixed.split('\n').filter((row) => row.includes(BULLET))).toHaveLength(2)
  })

  it('shows a change and its diff without being asked', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'edit',
          output: {
            path: `${CWD}/src/a.ts`,
            diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+const two = 2\n',
          },
        }),
      ]),
    )

    expect(frame).toContain('Edited src/a.ts')
    expect(frame).toContain('const two = 2')
  })

  it('shows a created file in the panel a diff would have taken, without the diff colours', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'write',
          input: { path: `${CWD}/src/new.ts`, content: 'export const two = 2\nexport const three = 3\n' },
          output: { path: `${CWD}/src/new.ts`, created: true, bytes: 44 },
        }),
      ]),
    )

    expect(frame).toContain('Created src/new.ts')
    expect(frame).toContain('export const three = 3')
    expect(frame).toContain('2 lines')
    // Nothing is signed: every line of a new file is new, so the `+` column would say it of all of them.
    expect(frame).not.toContain('+ export')
  })

  it('says nothing extra when a write reported no content to show', async () => {
    const frame = await frameOf(
      runOf([
        call({
          name: 'write',
          input: { path: `${CWD}/src/new.ts` },
          output: { path: `${CWD}/src/new.ts`, created: true, bytes: 44 },
        }),
      ]),
    )

    expect(frame).toContain('Created src/new.ts')
  })

  it('opens a refused call onto the reason it was refused', async () => {
    const refused = call({
      name: 'write',
      input: { path: `${CWD}/outside.ts` },
      state: ECallState.Denied,
      note: 'the path is outside the workspace root',
    })
    const run = runOf([refused])

    expect(await frameOf(run)).toContain('Refused write outside.ts')
    expect(await frameOf(run)).not.toContain('outside the workspace root')
    expect(await frameOf(run, new Set([refused.callId]))).toContain('outside the workspace root')
  })

  it('opens a call the tool could not complete onto the error the model was handed', async () => {
    const broken = call({
      name: 'read',
      input: { path: `${CWD}/gone.ts` },
      state: ECallState.Failed,
      note: 'no file at /repo/gone.ts',
    })
    const run = runOf([broken])
    const frame = await frameOf(run, new Set([broken.callId]))

    expect(frame).toContain('Failed read gone.ts')
    expect(frame).toContain('no file at /repo/gone.ts')
  })

  it('lists the calls once the sentence is opened, and not before', async () => {
    const run = runOf([read('theme.ts', 1), read('paths.ts', 1)])

    expect(await frameOf(run)).not.toContain('paths.ts')
    expect(await frameOf(run, new Set([`sentence:${run.calls[0]?.callId ?? ''}`]))).toContain(
      'paths.ts',
    )
  })
})
