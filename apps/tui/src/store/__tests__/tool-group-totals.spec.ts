import { describe, expect, it } from 'bun:test'

import { EToolVerb } from '../../ui/tool-verbs'
import { EGroupState, liveToolGroups, toolGroups, type LiveToolCall } from '../tool-groups'
import { log } from './fixture'
import { called, callId, clocked, result } from './tool-fixture'

describe('the totals a group rolls up', () => {
  it('sums the line counts the results carried', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'edit', input: { path: 'a.ts' } }),
        result({ n: 1, name: 'edit', output: { added: 34, removed: 7 } }),
        called({ n: 2, name: 'edit', input: { path: 'b.ts' } }),
        result({ n: 2, name: 'edit', output: { added: 31, removed: 7 } }),
      ]),
    )

    expect(groups[0]?.totals).toMatchObject({ count: 2, added: 65, removed: 14 })
  })

  it('sums a pass count across a run of commands', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'bash', input: { command: 'bun test store' } }),
        result({ n: 1, name: 'bash', output: { passed: 12 } }),
        called({ n: 2, name: 'bash', input: { command: 'bun test ui' } }),
        result({ n: 2, name: 'bash', output: { passed: 7 } }),
      ]),
    )

    expect(groups[0]?.totals.passed).toBe(19)
    expect(groups[0]?.label).toBe('Ran 2 commands')
  })

  it('leaves the totals absent rather than guessing when the output says nothing readable', () => {
    for (const output of ['just a string', 42, null, undefined, [], { added: 'lots' }]) {
      const groups = toolGroups(
        log([called({ n: 1, name: 'edit' }), result({ n: 1, name: 'edit', output })]),
      )

      expect(groups[0]?.totals).toMatchObject({ count: 1, added: null, removed: null, passed: null })
      expect(groups[0]?.state).toBe(EGroupState.Ok)
    }
  })

  it('reads only the halves it can, when a result carries one of them', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'write', input: { path: 'new.ts' } }),
        result({ n: 1, name: 'write', output: { lines: 52, created: true } }),
      ]),
    )

    expect(groups[0]?.totals).toMatchObject({ added: null, removed: null })
    expect(groups[0]?.calls[0]?.totals).toMatchObject({ lines: 52, created: true })
  })

  it('takes the target from whichever key the input used to name it', () => {
    const groups = toolGroups(
      log([
        called({ n: 1, name: 'read', input: { path: 'src/auth/jwt.ts' } }),
        called({ n: 2, name: 'read', input: { filePath: 'src/users/users.ts' } }),
        called({ n: 3, name: 'read', input: { nothing: 'useful' } }),
      ]),
    )

    expect(groups[0]?.calls.map((call) => call.target)).toEqual([
      'src/auth/jwt.ts',
      'src/users/users.ts',
      null,
    ])
  })
})

describe('how long a group took', () => {
  it('spans the first call to the last result, taken off the event clock', () => {
    const groups = toolGroups(
      clocked([
        { draft: called({ n: 1, name: 'bash' }), at: '2026-01-01T00:00:00.000Z' },
        { draft: result({ n: 1, name: 'bash' }), at: '2026-01-01T00:00:03.000Z' },
        { draft: called({ n: 2, name: 'bash' }), at: '2026-01-01T00:00:03.500Z' },
        { draft: result({ n: 2, name: 'bash' }), at: '2026-01-01T00:00:08.000Z' },
      ]),
    )

    expect(groups[0]?.settledAtMs).not.toBeNull()
    expect((groups[0]?.settledAtMs ?? 0) - (groups[0]?.startedAtMs ?? 0)).toBe(8_000)
  })

  it('has no settled time to report while it is still running', () => {
    const groups = toolGroups(
      clocked([{ draft: called({ n: 1, name: 'bash' }), at: '2026-01-01T00:00:00.000Z' }]),
    )

    expect(groups[0]?.startedAtMs).not.toBeNull()
    expect(groups[0]?.settledAtMs).toBeNull()
  })
})

describe('the key a group is drawn under', () => {
  it('is the same every time the same log is projected', () => {
    const events = log([
      called({ n: 1, name: 'read' }),
      called({ n: 2, name: 'read' }),
      called({ n: 3, name: 'bash' }),
    ])

    expect(toolGroups(events).map((group) => group.key)).toEqual(
      toolGroups(events).map((group) => group.key),
    )
  })

  it('survives the group settling, so the row is never remounted', () => {
    const opening = [called({ n: 1, name: 'read' })]
    const live = toolGroups(log(opening))
    const settled = toolGroups(log([...opening, result({ n: 1, name: 'read' })]))

    expect(live[0]?.key).toBe(settled[0]?.key)
    expect(live[0]?.state).not.toBe(settled[0]?.state)
  })

  it('names the call that opened it, so a live projection can hand over to the durable one', () => {
    const groups = toolGroups(log([called({ n: 7, name: 'read' }), called({ n: 8, name: 'read' })]))

    expect(groups[0]?.openedBy).toBe(callId(7))
    expect(groups[0]?.key).toContain('call-7')
  })
})

describe('calls that have only been streamed', () => {
  const streamed = (args: { n: number; name: string; after: number }): LiveToolCall => ({
    callId: callId(args.n),
    name: args.name,
    input: {},
    precededByBlocks: args.after,
  })

  it('groups by verb the same way, and every group is live', () => {
    const groups = liveToolGroups([
      streamed({ n: 1, name: 'read', after: 0 }),
      streamed({ n: 2, name: 'read', after: 0 }),
      streamed({ n: 3, name: 'bash', after: 0 }),
    ])

    expect(groups.map((live) => [live.group.verb.verb, live.group.totals.count])).toEqual([
      [EToolVerb.Read, 2],
      [EToolVerb.Bash, 1],
    ])
    expect(groups.every((live) => live.group.state === EGroupState.Live)).toBe(true)
  })

  it('breaks the run when text was streamed between two calls of the same verb', () => {
    const groups = liveToolGroups([
      streamed({ n: 1, name: 'read', after: 0 }),
      streamed({ n: 2, name: 'read', after: 1 }),
    ])

    expect(groups.map((live) => live.precededByBlocks)).toEqual([0, 1])
  })

  it('has no clock to report, because a chunk carries no timestamp', () => {
    const groups = liveToolGroups([streamed({ n: 1, name: 'bash', after: 0 })])

    expect(groups[0]?.group.startedAtMs).toBeNull()
    expect(groups[0]?.group.settledAtMs).toBeNull()
  })

  it('opens under the same key the durable projection will use', () => {
    const streamedKey = liveToolGroups([streamed({ n: 1, name: 'read', after: 0 })])[0]?.group.key
    const durableKey = toolGroups(log([called({ n: 1, name: 'read' })]))[0]?.key

    expect(streamedKey).toBe(durableKey)
  })
})
