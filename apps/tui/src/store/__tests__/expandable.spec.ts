import { describe, expect, it } from 'bun:test'

import { toCallId } from '@dltech/atlas-core'

import { newestExpandableKey } from '../expandable'
import { ECallState, type ToolCall, type ToolRun } from '../tool-runs'
import { EAuthor, EEntryKind, toolsRanEntry, type TranscriptEntry } from '../transcript-model'

const thought = (args: {
  key: string
  streaming: boolean
  heldOpen?: boolean
  text?: string
}): TranscriptEntry => ({
  kind: EEntryKind.ModelThought,
  author: EAuthor.Model,
  key: args.key,
  text: args.text ?? 'weighed a denylist against a token version',
  streaming: args.streaming,
  heldOpen: args.heldOpen ?? false,
  interrupted: false,
})

const said = (key: string): TranscriptEntry => ({
  kind: EEntryKind.ModelSaid,
  author: EAuthor.Model,
  key,
  text: 'rotation is in',
  streaming: false,
  interrupted: false,
})

const row = (args: { key: string; index: number; state: ECallState }): ToolCall => ({
  callId: toCallId(`${args.key}-${args.index}`),
  name: 'read',
  input: { path: 'a.ts' },
  output: { path: 'a.ts', lines: 12 },
  modelText: '',
  state: args.state,
  note: null,
  at: null,
  settledAt: null,
})

const run = (args: { key: string; state: ECallState; calls: number }): ToolRun => ({
  key: args.key,
  openedBy: toCallId(args.key),
  calls: Array.from({ length: args.calls }, (_unused, index) =>
    row({ key: args.key, index, state: args.state }),
  ),
})

describe('what ⏎ open acts on', () => {
  it('finds nothing in an empty transcript', () => {
    expect(newestExpandableKey([])).toBeNull()
  })

  it('ignores what the model said, which is already open', () => {
    expect(newestExpandableKey([said('a1')])).toBeNull()
  })

  it('takes the newest thing that can be unfolded, not the first', () => {
    const entries = [thought({ key: 't1', streaming: false }), said('a1'), thought({ key: 't2', streaming: false })]
    expect(newestExpandableKey(entries)).toBe('t2')
  })

  it('leaves thinking alone while it is still streaming', () => {
    expect(newestExpandableKey([thought({ key: 't1', streaming: true })])).toBeNull()
  })

  it('leaves thinking alone while it is held open showing its own tail', () => {
    expect(
      newestExpandableKey([thought({ key: 't1', streaming: false, heldOpen: true })]),
    ).toBeNull()
  })

  it('leaves an empty thought alone, since there is nothing behind it', () => {
    expect(newestExpandableKey([thought({ key: 't1', streaming: false, text: '' })])).toBeNull()
  })

  it('opens a settled tool group', () => {
    const entry = toolsRanEntry(run({ key: 'g1', state: ECallState.Ok, calls: 3 }))
    expect(newestExpandableKey([entry])).toBe('g1')
  })

  it('leaves a running tool group alone — it is already showing its tail', () => {
    const entry = toolsRanEntry(run({ key: 'g1', state: ECallState.Pending, calls: 3 }))
    expect(newestExpandableKey([entry])).toBeNull()
  })

  it('prefers a tool group over older thinking', () => {
    const entries = [
      thought({ key: 't1', streaming: false }),
      toolsRanEntry(run({ key: 'g1', state: ECallState.Ok, calls: 2 })),
    ]
    expect(newestExpandableKey(entries)).toBe('g1')
  })
})
