import { describe, expect, it } from 'bun:test'
import React from 'react'

import { ERetryReason } from '@dltech/atlas-core'

import { EMPTY_TRANSCRIPT, EPendingKind, type TranscriptModel } from '../../store'
import { RAIL, RAIL_HEAD, RAIL_TAIL } from '../borders'
import { Composer } from '../components/composer'
import { JumpToBottom, NewDivider } from '../components/new-divider'
import type { TurnClock } from '../components/transcript'
import { WaitingLine, WorkingLine } from '../components/working-line'
import type { RetryWait } from '../retry-countdown'
import { useDraft } from '../hooks/use-draft'
import { grammarsReady } from '../markdown/__tests__/harness'
import { deriveTranscript } from '../../store'
import { called, clocked, result, said } from '../../store/__tests__/tool-fixture'
import { glyph } from '../theme'
import {
  FAILED_SILENTLY,
  FAILED_WITH_A_REASON,
  FINISHED,
  frameOf,
  INTERRUPTED,
  INTERRUPTING,
  LAST_WORDS,
  mount,
  PARTIAL_REPLY,
  REASONING,
  RUNNING,
  SETTLED,
  STREAMING,
  STREAMING_REPLY,
  transcript,
  TURN_DONE,
  TURN_STOPPED,
  WIDTHS,
} from './transcript-fixture'

/**
 * OpenTUI's `<text>` accepts strings, text nodes and styled text — NOT nested `<text>` elements, so
 * a component returning `<text>` rendered inside another one throws at mount and nothing in the type
 * system catches it: the nesting only exists once the component has been expanded. These mount for
 * real rather than snapshotting for that reason.
 */

await grammarsReady()

const AT = '2026-08-26T12:00:00.000Z'

const CASES: Record<string, { model: TranscriptModel; turn?: TurnClock; anchorKey?: string }> = {
  'a settled conversation': { model: SETTLED },
  'an empty conversation': { model: EMPTY_TRANSCRIPT },
  'thinking as it streams': { model: STREAMING, turn: RUNNING },
  'a reply as it streams': { model: STREAMING_REPLY, turn: RUNNING },
  'an interrupted turn': { model: INTERRUPTED, turn: INTERRUPTING },
  'a failure that named a reason': { model: FAILED_WITH_A_REASON },
  'a failure that named none': { model: FAILED_SILENTLY },
  'a finished turn, still counted': { model: SETTLED, turn: FINISHED },
  'a divider above the first thing unseen': { model: SETTLED, anchorKey: 'u2' },
}

describe('the transcript mounts', () => {
  for (const [name, args] of Object.entries(CASES)) {
    it(`renders ${name} at every width`, async () => {
      for (const width of WIDTHS) {
        await expect(mount(transcript({ ...args, width }), width)).resolves.toBeUndefined()
      }
    }, 120_000)
  }
})

describe('what the transcript actually says', () => {
  it('draws the newest exchange, which is where a settled transcript sits', async () => {
    const frame = await frameOf(transcript({ model: SETTLED, width: 80 }), 80)
    expect(frame).toContain('and the composer?')
    expect(frame).toContain(LAST_WORDS)
  })

  it('gives the operator a railed panel and leaves the model as prose', async () => {
    const frame = await frameOf(transcript({ model: SETTLED, width: 80 }), 80)
    const rows = frame.split('\n')
    expect(rows.some((row) => row.startsWith(RAIL_HEAD))).toBe(true)
    expect(rows.some((row) => row.startsWith(RAIL_TAIL))).toBe(true)
    expect(rows.some((row) => row.startsWith(`${RAIL}  ${LAST_WORDS}`))).toBe(false)
    expect(rows.some((row) => row.startsWith(`${glyph.block} ${LAST_WORDS}`))).toBe(true)
  })

  it('keeps thinking visibly apart from the answer while it streams', async () => {
    const frame = await frameOf(transcript({ model: STREAMING, width: 80, turn: REASONING }), 80)
    expect(frame).toContain(glyph.thinking)
    expect(frame).toContain('Thinking…')
    expect(frame).toContain('Thinking for')
  })

  it('says it is working, not thinking, when no reasoning block is streaming', async () => {
    const frame = await frameOf(transcript({ model: STREAMING, width: 80, turn: RUNNING }), 80)
    expect(frame).toContain('Working for')
    expect(frame).not.toContain('Thinking for')
  })

  it('leaves a finished turn pinned to the reply it measured, with what it cost and when', async () => {
    const rows = (await frameOf(transcript({ model: TURN_DONE, width: 80 }), 80)).split('\n')

    const reply = rows.findIndex((row) => row.includes('done'))
    const worked = rows.findIndex((row) => row.includes('Worked for'))

    expect(worked).toBeGreaterThan(reply)
    expect(rows[worked]).toContain('54s')
    expect(rows[worked]).toContain('1.1k tokens')
    expect(rows[worked]).toContain('6:32pm')
  })

  it('says a stopped turn was stopped rather than worked', async () => {
    const frame = await frameOf(transcript({ model: TURN_STOPPED, width: 80 }), 80)

    expect(frame).toContain('Stopped after 12s')
    expect(frame).not.toContain('tokens')
  })

  it('draws no finished turn of its own, so history cannot drift from the log', async () => {
    const frame = await frameOf(transcript({ model: SETTLED, width: 80, turn: FINISHED }), 80)

    expect(frame).not.toContain('Worked for')
    expect(frame).not.toContain('Thought for')
  })

  it('renders a failure alongside the partial reply, never as silence', async () => {
    const named = await frameOf(transcript({ model: FAILED_WITH_A_REASON, width: 80 }), 80)
    expect(named).toContain(`${glyph.failed} failed`)
    expect(named).toContain('overloaded')
    expect(named).toContain(PARTIAL_REPLY)

    const unnamed = await frameOf(transcript({ model: FAILED_SILENTLY, width: 80 }), 80)
    expect(unnamed).toContain(`${glyph.failed} failed`)
    expect(unnamed).toContain('partial')
  })

  it('offers the one key that gets the turn moving again, and only when it is wired', async () => {
    const offered = await frameOf(
      transcript({ model: FAILED_WITH_A_REASON, width: 80, onRetry: () => undefined }),
      80,
    )
    expect(offered).toContain(`${glyph.retry} ctrl+r retry`)

    const bare = await frameOf(transcript({ model: FAILED_WITH_A_REASON, width: 80 }), 80)
    expect(bare).not.toContain('retry')
  })

  it('lets the failed slab carry the cost rather than repeating it in a working line', async () => {
    const frame = await frameOf(
      transcript({ model: FAILED_WITH_A_REASON, width: 80, turn: FINISHED }),
      80,
    )
    expect(frame).not.toContain('Worked for')
  })

  it('leaves a blank row between a reply and the tools it asked for', async () => {
    const events = clocked([
      { draft: said('Reading the pieces that already exist.'), at: AT },
      { draft: called({ n: 1, name: 'read', input: { path: 'a.ts' } }), at: AT },
      { draft: result({ n: 1, name: 'read', output: { lines: 10 } }), at: AT },
      { draft: said('Editing in one pass.'), at: AT },
      { draft: called({ n: 2, name: 'edit', input: { path: 'a.ts' } }), at: AT },
      { draft: result({ n: 2, name: 'edit', output: { added: 4, removed: 1 } }), at: AT },
    ])
    const model = deriveTranscript({ events, signals: [] })
    const rows = (await frameOf(transcript({ model, width: 100 }), 100)).split('\n')

    // The reply used to hug the group below it, which read well when a group was one summary line
    // and badly once a run became a stack of rows: the prose ended up touching the first of them.
    const reply = rows.findIndex((row) => row.includes('Reading the pieces'))
    const group = rows.findIndex((row) => row.includes('Read a.ts'))
    expect(group).toBe(reply + 2)
    expect(rows[reply + 1]?.trim()).toBe('')

    const next = rows.findIndex((row) => row.includes('Editing in one pass'))
    expect(rows[next - 1]?.trim()).toBe('')
  })

  it('marks the head of a cluster of tool rows and leaves the rest of it unmarked', async () => {
    const events = clocked([
      { draft: said('Reading, then editing.'), at: AT },
      { draft: called({ n: 1, name: 'read', input: { path: 'a.ts' } }), at: AT },
      { draft: result({ n: 1, name: 'read', output: { lines: 10 } }), at: AT },
      { draft: called({ n: 2, name: 'edit', input: { path: 'a.ts' } }), at: AT },
      { draft: result({ n: 2, name: 'edit', output: { added: 4, removed: 1 } }), at: AT },
    ])
    const model = deriveTranscript({ events, signals: [] })
    const rows = (await frameOf(transcript({ model, width: 100 }), 100)).split('\n')

    const read = rows.findIndex((row) => row.includes('Read a.ts'))
    const edited = rows.findIndex((row) => row.includes('Edited a.ts'))

    expect(read).toBeGreaterThan(0)
    expect(edited).toBeGreaterThan(read)

    // The first row of the cluster carries the mark. The rows under it do not — what the reader
    // wants to see is where the tools stop, not a column of identical dots.
    expect(rows[read]).toContain(glyph.block)
    expect(rows[edited]).toContain(glyph.block)
    expect(rows.slice(read, edited).filter((row) => row.includes(glyph.block))).toHaveLength(1)
  })

  it('keeps a message sent mid-turn where it landed, rather than hiding it or moving it', async () => {
    const events = clocked([
      { draft: said('Reading the pieces that already exist.'), at: AT },
      { draft: called({ n: 1, name: 'read', input: { path: 'a.ts' } }), at: AT },
      { draft: { type: 'user-said', text: 'check the tests too' }, at: AT },
      { draft: result({ n: 1, name: 'read', output: { lines: 10 } }), at: AT },
    ])
    const model = deriveTranscript({ events, signals: [] })
    const rows = (await frameOf(transcript({ model, width: 100 }), 100)).split('\n')

    const group = rows.findIndex((row) => row.includes('Read a.ts'))
    const said1 = rows.findIndex((row) => row.includes('check the tests too'))

    expect(said1).toBeGreaterThan(group)
  })

  it('stands a queued message under the working line, where the transcript has not got it yet', async () => {
    const rows = (
      await frameOf(
        transcript({
          model: STREAMING,
          width: 80,
          turn: RUNNING,
          pending: [
            { kind: EPendingKind.Operator, id: 'p1', text: 'check the tests too', taken: false },
            { kind: EPendingKind.Operator, id: 'p2', text: 'and the fixtures', taken: false },
          ],
        }),
        80,
      )
    ).split('\n')

    const working = rows.findIndex((row) => row.includes('Working for'))
    const first = rows.findIndex((row) => row.includes('check the tests too'))
    const second = rows.findIndex((row) => row.includes('and the fixtures'))

    expect(first).toBeGreaterThan(working)
    expect(second).toBeGreaterThan(first)
    expect(rows[first]).toContain(RAIL)
  })

  it('gives consecutive queued messages one panel rather than stacking one each', async () => {
    const rows = (
      await frameOf(
        transcript({
          model: STREAMING,
          width: 80,
          turn: RUNNING,
          pending: [
            { kind: EPendingKind.Operator, id: 'p1', text: 'hi', taken: false },
            { kind: EPendingKind.Operator, id: 'p2', text: 'how', taken: false },
            { kind: EPendingKind.Operator, id: 'p3', text: 'are', taken: false },
            { kind: EPendingKind.Operator, id: 'p4', text: 'you?', taken: false },
          ],
        }),
        80,
      )
    ).split('\n')

    const working = rows.findIndex((row) => row.includes('Working for'))
    const queued = rows.slice(working)

    expect(queued.filter((row) => row.startsWith(RAIL_HEAD)).length).toBe(1)
    expect(queued.filter((row) => row.startsWith(RAIL_TAIL)).length).toBe(1)
    expect(queued.some((row) => row.includes('hi'))).toBe(true)
    expect(queued.some((row) => row.includes('you?'))).toBe(true)
  })

  it('gives a queued message the same panel the transcript gives a sent one', async () => {
    const rows = (
      await frameOf(
        transcript({
          model: STREAMING,
          width: 80,
          turn: RUNNING,
          pending: [{ kind: EPendingKind.Operator, id: 'p1', text: 'check the tests too', taken: false }],
        }),
        80,
      )
    ).split('\n')

    const said = rows.findIndex((row) => row.includes('check the tests too'))
    expect(rows[said]).toContain(RAIL)
    expect(rows[said - 1]).toContain(RAIL_HEAD)
    expect(rows[said + 1]).toContain(RAIL_TAIL)
  })

  it('says how to get a queued message back, since nothing else would tell you', async () => {
    const frame = await frameOf(
      transcript({
        model: STREAMING,
        width: 80,
        turn: RUNNING,
        pending: [{ kind: EPendingKind.Operator, id: 'p1', text: 'check the tests too', taken: false }],
      }),
      80,
    )

    expect(frame).toContain('↑ to edit')
  })

  it('stops offering it back once the loop has taken it, while it still stands there', async () => {
    const frame = await frameOf(
      transcript({
        model: STREAMING,
        width: 80,
        turn: RUNNING,
        pending: [{ kind: EPendingKind.Operator, id: 'p1', text: 'check the tests too', taken: true }],
      }),
      80,
    )

    expect(frame).toContain('check the tests too')
    expect(frame).not.toContain('↑ to edit')
  })

  it('stands a background shell ending in the same queue, for show only', async () => {
    const frame = await frameOf(
      transcript({
        model: STREAMING,
        width: 80,
        turn: RUNNING,
        pending: [
          {
            kind: EPendingKind.BackgroundShell,
            id: 'shell-ended-bash_1',
            text: 'Background shell "Run full TUI suite" completed (exit code 0)',
            failed: false,
          },
        ],
      }),
      80,
    )

    expect(frame).toContain('Background shell "Run full TUI suite" completed (exit code 0)')
    expect(frame).toContain('queued')
    expect(frame).not.toContain('↑ to edit')
  })

  it('offers the take-back to the typed message rather than to a shell queued after it', async () => {
    const frame = await frameOf(
      transcript({
        model: STREAMING,
        width: 80,
        turn: RUNNING,
        pending: [
          { kind: EPendingKind.Operator, id: 'p1', text: 'check the tests too', taken: false },
          {
            kind: EPendingKind.BackgroundShell,
            id: 'shell-ended-bash_1',
            text: 'Background shell `bun test` was killed',
            failed: false,
          },
        ],
      }),
      80,
    ).then((text) => text.split('\n'))

    const typed = frame.findIndex((row) => row.includes('check the tests too'))
    const shell = frame.findIndex((row) => row.includes('was killed'))
    const takeBack = frame.findIndex((row) => row.includes('↑ to edit'))

    expect(shell).toBeGreaterThan(typed)
    expect(takeBack).toBeLessThan(shell)
  })

  it('shows nothing at all when the queue is empty', async () => {
    const frame = await frameOf(
      transcript({ model: STREAMING, width: 80, turn: RUNNING, pending: [] }),
      80,
    )

    expect(frame).not.toContain('↑ to edit')
  })

  it('rules off the first thing the operator has not seen', async () => {
    const frame = await frameOf(transcript({ model: SETTLED, width: 80, anchorKey: 'u2' }), 80)
    expect(frame).toContain(' new ')
  })
})

const WAITING: RetryWait = {
  attempt: 2,
  maxAttempts: 10,
  delayMs: 8_000,
  reason: ERetryReason.Overloaded,
  startedAt: RUNNING.startedAt ?? 0,
}

describe('the pieces around the transcript mount', () => {
  it('renders the working line in each of its states', async () => {
    for (const state of [
      { elapsedMs: 4_000, outputTokens: 0, interrupting: false },
      { elapsedMs: 94_000, outputTokens: 12_400, interrupting: false },
      { elapsedMs: 94_000, outputTokens: 12_400, interrupting: true },
      { elapsedMs: 4_000, outputTokens: 0, interrupting: false, retry: WAITING },
    ]) {
      await expect(mount(<WorkingLine {...state} />, 60)).resolves.toBeUndefined()
    }
  }, 60_000)

  it('renders the waiting line for every count it can carry', async () => {
    for (const work of [
      { agents: 2, shells: 0 },
      { agents: 0, shells: 1 },
      { agents: 1, shells: 3 },
    ]) {
      await expect(mount(<WaitingLine work={work} />, 60)).resolves.toBeUndefined()
    }
  }, 60_000)

  it('waits on what the settled turn left running', async () => {
    const frame = await frameOf(
      transcript({ model: SETTLED, width: 80, background: { agents: 2, shells: 1 } }),
      80,
    )

    expect(frame).toContain('2 background agents and 1 shell to finish')
  })

  it('says nothing about the background while the turn is still streaming', async () => {
    const frame = await frameOf(
      transcript({
        model: STREAMING,
        width: 80,
        turn: RUNNING,
        background: { agents: 2, shells: 1 },
      }),
      80,
    )

    expect(frame).not.toContain('background agents')
  })

  it('keeps waiting on the background after the turn failed', async () => {
    const frame = await frameOf(
      transcript({
        model: FAILED_WITH_A_REASON,
        width: 80,
        background: { agents: 1, shells: 0 },
      }),
      80,
    )

    expect(frame).toContain('1 background agent to finish')
  })

  it('times the wait itself, which starts at nothing the moment the turn settles', async () => {
    const frame = await frameOf(
      transcript({
        model: SETTLED,
        width: 80,
        background: { agents: 0, shells: 1 },
        waitingSince: Date.now(),
      }),
      80,
    )

    expect(frame).toContain('1 shell to finish · 0s')
  })

  /**
   * The regression this guards is a fresh mount: opening a sub-agent unmounts the transcript, so a
   * wait measured where it is drawn would come back reading zero however long it had really been.
   */
  it('reads the wait from the origin it is handed, not from when it was mounted', async () => {
    const frame = await frameOf(
      transcript({
        model: SETTLED,
        width: 80,
        background: { agents: 0, shells: 1 },
        waitingSince: Date.now() - 90_000,
      }),
      80,
    )

    expect(frame).toContain('1 shell to finish · 1m 30s')
  })

  it('says what it is waiting on with no origin to time it against', async () => {
    const frame = await frameOf(
      transcript({ model: SETTLED, width: 80, background: { agents: 0, shells: 1 } }),
      80,
    )

    expect(frame).toContain('1 shell to finish')
    expect(frame).not.toContain('finish · ')
  })

  it('takes no room once the background is empty', async () => {
    const frame = await frameOf(
      transcript({ model: SETTLED, width: 80, background: { agents: 0, shells: 0 } }),
      80,
    )

    expect(frame).not.toContain('Waiting for')
  })

  it('says what went wrong instead of claiming to be working', async () => {
    const frame = await frameOf(
      transcript({ model: STREAMING, width: 80, turn: { ...RUNNING, retry: WAITING } }),
      80,
    )

    expect(frame).toContain('API overloaded')
    expect(frame).toContain('attempt 2/10')
    expect(frame).not.toContain('Working for')
  })

  it('renders the new divider and the jump pill', async () => {
    for (const width of WIDTHS) {
      await expect(mount(<NewDivider width={width} />, width)).resolves.toBeUndefined()
      await expect(
        mount(<JumpToBottom width={width} onJump={() => {}} />, width),
      ).resolves.toBeUndefined()
    }
  }, 60_000)

  it('renders the composer, which takes plain text and nothing else', async () => {
    function Draft(props: { width: number }): React.ReactNode {
      const draft = useDraft('a restored draft\nover two rows')
      return <Composer draft={draft} width={props.width} placeholder="Describe the work." />
    }

    for (const width of WIDTHS) {
      await expect(mount(<Draft width={width} />, width)).resolves.toBeUndefined()
    }
  }, 60_000)
})
