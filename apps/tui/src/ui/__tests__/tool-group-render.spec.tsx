import { describe, expect, it } from 'bun:test'
import React from 'react'

import type { EventDraft } from '@dltech/atlas-core'

import { liveToolGroups, toolGroups, toolsRanEntry, type ToolGroup, type TranscriptModel } from '../../store'
import { called, callId, clocked, failed, result } from '../../store/__tests__/tool-fixture'
import { ToolGroupBlock } from '../components/blocks/tool-group-block'
import { cellsOf } from '../hint-layout'
import { glyph } from '../theme'
import { frameOf, mount, NOW, transcript, WIDTHS } from './transcript-fixture'

const SECOND = 1_000

const at = (offsetMs: number): string => new Date(NOW - 60 * SECOND + offsetMs).toISOString()

const only = (groups: readonly ToolGroup[]): ToolGroup => {
  const group = groups[0]
  if (group === undefined) throw new Error('the fixture projected no tool group')
  return group
}

type Beat = { draft: EventDraft; at: string }

const ran = (args: { n: number; name: string; input: unknown; atMs: number }): Beat => ({
  draft: called({ n: args.n, name: args.name, input: args.input }),
  at: at(args.atMs),
})

const back = (args: { n: number; name: string; output: unknown; atMs: number }): Beat => ({
  draft: result({ n: args.n, name: args.name, output: args.output }),
  at: at(args.atMs),
})

const groupOf = (beats: readonly Beat[]): ToolGroup => only(toolGroups(clocked(beats)))

const READ_PATHS = ['src/auth/jwt.strategy.ts', 'src/users/users.service.ts', 'src/auth/guard.ts']

const READS = groupOf(
  READ_PATHS.flatMap((path, index) => [
    ran({ n: index, name: 'read', input: { path }, atMs: index * 40 }),
    back({ n: index, name: 'read', output: { lines: 40 + index }, atMs: index * 40 + 20 }),
  ]),
)

const EDIT_FILES = [
  { path: 'src/revoked.store.ts', output: { lines: 52, created: true } },
  { path: 'src/auth.service.ts', output: { added: 34, removed: 7 } },
  { path: 'src/jwt.strategy.ts', output: { added: 83, removed: 7 } },
]

const EDITS = groupOf(
  EDIT_FILES.flatMap((file, index) => [
    ran({ n: index, name: 'edit', input: { path: file.path }, atMs: index * 10 }),
    back({ n: index, name: 'edit', output: file.output, atMs: index * 10 + 5 }),
  ]),
)

const COMMANDS = groupOf([
  ran({ n: 0, name: 'bash', input: { command: 'bun test store' }, atMs: 0 }),
  back({ n: 0, name: 'bash', output: { passed: 12 }, atMs: 3 * SECOND }),
  ran({ n: 1, name: 'bash', input: { command: 'bun test ui' }, atMs: 3 * SECOND }),
  back({ n: 1, name: 'bash', output: { passed: 7 }, atMs: 8 * SECOND }),
])

const FAILED = groupOf([
  ran({ n: 0, name: 'edit', input: { path: 'src/gone.ts' }, atMs: 0 }),
  { draft: failed({ n: 0, name: 'edit', message: 'no such file' }), at: at(20) },
])

const RUNNING_READS = groupOf([
  ...READ_PATHS.map((path, index) =>
    ran({ n: index, name: 'read', input: { path }, atMs: index * 40 }),
  ),
  back({ n: 0, name: 'read', output: {}, atMs: 100 }),
])

const RUNNING_COMMAND = groupOf([
  ran({ n: 0, name: 'bash', input: { command: 'bun test auth --coverage' }, atMs: 0 }),
])

const STREAMED_READS = only(
  liveToolGroups(
    READ_PATHS.map((path, index) => ({
      callId: callId(index),
      name: 'read',
      input: { path },
      precededByBlocks: 0,
    })),
  ).map((live) => live.group),
)

const block = (args: { group: ToolGroup; width: number; expanded?: boolean }): React.ReactNode => (
  <ToolGroupBlock
    group={args.group}
    width={args.width}
    now={NOW}
    expanded={args.expanded ?? false}
    onToggle={() => {}}
  />
)

const GROUPS: Record<string, ToolGroup> = {
  'a run of reads': READS,
  'a run of edits': EDITS,
  'a run of commands': COMMANDS,
  'a run that failed': FAILED,
  'a run still going': RUNNING_READS,
  'a single command still going': RUNNING_COMMAND,
  'a run that has only been streamed': STREAMED_READS,
}

describe('a tool group mounts', () => {
  for (const [name, group] of Object.entries(GROUPS)) {
    it(`renders ${name} at every width, open and closed`, async () => {
      for (const width of WIDTHS) {
        await expect(mount(block({ group, width }), width)).resolves.toBeUndefined()
        await expect(
          mount(block({ group, width, expanded: true }), width),
        ).resolves.toBeUndefined()
      }
    }, 120_000)
  }
})

describe('what a settled group says', () => {
  it('rails the group under one row, naming the verb and what it touched', async () => {
    const frame = await frameOf(block({ group: READS, width: 80 }), 80)

    expect(frame).toContain(`${glyph.result} Read 3 files`)
    expect(frame).toContain('src/auth, src/users')
    expect(frame).toContain('⏎ list')
  })

  it('reports a mutation as lines added and removed, and offers it for review', async () => {
    const frame = await frameOf(block({ group: EDITS, width: 80 }), 80)

    expect(frame).toContain(`${glyph.result} Edited 3 files`)
    expect(frame).toContain('+117')
    expect(frame).toContain('−14')
    expect(frame).toContain('⏎ review')
  })

  it('uses the minus sign rather than a hyphen for a removal', async () => {
    const frame = await frameOf(block({ group: EDITS, width: 80 }), 80)

    expect(frame).toContain('−14')
    expect(frame).not.toContain('-14')
  })

  it('reports a run of commands as passes and the time it took', async () => {
    const frame = await frameOf(block({ group: COMMANDS, width: 80 }), 80)

    expect(frame).toContain(`${glyph.result} Ran 2 commands`)
    expect(frame).toContain('19 pass')
    expect(frame).toContain('8s')
  })

  it('names a failure on the call that failed once the group is opened', async () => {
    const frame = await frameOf(block({ group: FAILED, width: 80, expanded: true }), 80)

    expect(frame).toContain('Edited 1 file')
    expect(frame).toContain('no such file')
  })

  it('lists one row per call when opened, and drops the affordance that opened it', async () => {
    const frame = await frameOf(block({ group: EDITS, width: 80, expanded: true }), 80)

    expect(frame).toContain('revoked.store.ts')
    expect(frame).toContain('auth.service.ts')
    expect(frame).toContain('+34')
    expect(frame).toContain('new')
    expect(frame).toContain('52')
    expect(frame).not.toContain('⏎ review')
  })
})

describe('what a running group says', () => {
  it('counts what is done against what was asked for, and shows the last calls', async () => {
    const frame = await frameOf(block({ group: RUNNING_READS, width: 80 }), 80)

    expect(frame).toContain('Reading files')
    expect(frame).toContain('1 of ~3')
    expect(frame).toContain('users.service.ts')
    expect(frame).toContain('guard.ts')
  })

  it('spells a lone running call out in full rather than counting it', async () => {
    const frame = await frameOf(block({ group: RUNNING_COMMAND, width: 80 }), 80)

    expect(frame).toContain('bash bun test auth --coverage')
    expect(frame).not.toContain('of ~')
  })

  it('rolls a streamed group that has no clock yet, without claiming a time', async () => {
    const frame = await frameOf(block({ group: STREAMED_READS, width: 80 }), 80)

    expect(frame).toContain('Reading files')
    expect(frame).toContain('0 of ~3')
  })
})

describe('a row that has to fit', () => {
  for (const width of WIDTHS) {
    it(`never wraps or overruns ${width} columns`, async () => {
      const frame = await frameOf(block({ group: EDITS, width, expanded: true }), width)

      for (const row of frame.split('\n')) expect(cellsOf(row)).toBeLessThanOrEqual(width)
    }, 60_000)
  }

  it('keeps the numbers and gives up the label when the terminal is narrow', async () => {
    const frame = await frameOf(block({ group: EDITS, width: 40 }), 40)

    expect(frame).toContain('+117')
    expect(frame).toContain('−14')
  })
})

describe('the transcript draws a tool group like any other entry', () => {
  const model = (group: ToolGroup): TranscriptModel => ({
    entries: [toolsRanEntry(group)],
    isEmpty: false,
    streaming: false,
    failure: null,
  })

  it('routes the entry through to the block', async () => {
    const frame = await frameOf(transcript({ model: model(EDITS), width: 80 }), 80)

    expect(frame).toContain('Edited 3 files')
  })

  it('mounts at every width', async () => {
    for (const width of WIDTHS) {
      await expect(
        mount(transcript({ model: model(READS), width }), width),
      ).resolves.toBeUndefined()
    }
  }, 120_000)
})
