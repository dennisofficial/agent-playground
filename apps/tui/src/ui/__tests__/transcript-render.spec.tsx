import { describe, expect, it } from 'bun:test'
import React from 'react'

import { EMPTY_TRANSCRIPT, type TranscriptModel } from '../../store'
import { Composer } from '../components/composer'
import { JumpToBottom, NewDivider } from '../components/new-divider'
import type { TurnClock } from '../components/transcript'
import { WorkingLine } from '../components/working-line'
import { useDraft } from '../hooks/use-draft'
import { grammarsReady } from '../markdown/__tests__/harness'
import { glyph } from '../theme'
import {
  CWD,
  FAILED_SILENTLY,
  FAILED_WITH_A_REASON,
  FINISHED,
  frameOf,
  INTERRUPTED,
  INTERRUPTING,
  LAST_WORDS,
  mount,
  PARTIAL_REPLY,
  RUNNING,
  SETTLED,
  STREAMING,
  STREAMING_REPLY,
  transcript,
  WIDTHS,
} from './transcript-fixture'

/**
 * OpenTUI's `<text>` accepts strings, text nodes and styled text — NOT nested `<text>` elements, so
 * a component returning `<text>` rendered inside another one throws at mount and nothing in the type
 * system catches it: the nesting only exists once the component has been expanded. These mount for
 * real rather than snapshotting for that reason.
 */

await grammarsReady()

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

  it('marks the operator and the model with different glyphs', async () => {
    const frame = await frameOf(transcript({ model: SETTLED, width: 80 }), 80)
    expect(frame).toContain(glyph.user)
    expect(frame).toContain(glyph.block)
  })

  it('keeps thinking visibly apart from the answer while it streams', async () => {
    const frame = await frameOf(transcript({ model: STREAMING, width: 80, turn: RUNNING }), 80)
    expect(frame).toContain(glyph.thinking)
    expect(frame).toContain('Thinking…')
    expect(frame).toContain('Working for')
  })

  it('renders a failure alongside the partial reply, never as silence', async () => {
    const named = await frameOf(transcript({ model: FAILED_WITH_A_REASON, width: 80 }), 80)
    expect(named).toContain('The turn failed')
    expect(named).toContain('overloaded')
    expect(named).toContain(PARTIAL_REPLY)

    const unnamed = await frameOf(transcript({ model: FAILED_SILENTLY, width: 80 }), 80)
    expect(unnamed).toContain('The turn failed')
    expect(unnamed).toContain('partial')
  })

  it('rules off the first thing the operator has not seen', async () => {
    const frame = await frameOf(transcript({ model: SETTLED, width: 80, anchorKey: 'u2' }), 80)
    expect(frame).toContain(' new ')
  })

  it('offers somewhere to start when there is nothing there yet', async () => {
    const frame = await frameOf(transcript({ model: EMPTY_TRANSCRIPT, width: 80 }), 80)
    expect(frame).toContain(CWD)
    expect(frame).toContain('Describe the work.')
  })
})

describe('the pieces around the transcript mount', () => {
  it('renders the working line in each of its states', async () => {
    for (const state of [
      { running: true, elapsedMs: 4_000, outputTokens: 0, interrupting: false },
      { running: true, elapsedMs: 94_000, outputTokens: 12_400, interrupting: false },
      { running: true, elapsedMs: 94_000, outputTokens: 12_400, interrupting: true },
      { running: false, elapsedMs: 92_000, outputTokens: 4_210, interrupting: false },
    ]) {
      await expect(mount(<WorkingLine {...state} />, 60)).resolves.toBeUndefined()
    }
  }, 60_000)

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
