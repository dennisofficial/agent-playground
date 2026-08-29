import { describe, expect, it } from 'bun:test'
import React from 'react'

import { CompactingOverlay } from '../components/compacting'
import { frameOf, mount } from './transcript-fixture'

const STARTED_AT = 1_000

const overlay = (over: { cancelling?: boolean; now?: number } = {}) => (
  <CompactingOverlay
    compacting={{ startedAt: STARTED_AT, cancelling: over.cancelling ?? false }}
    now={over.now ?? STARTED_AT + 3_000}
    width={80}
  />
)

describe('compaction while it runs', () => {
  it('says what it is doing and how long it has been at it', async () => {
    const frame = await frameOf(overlay(), 80)

    expect(frame).toContain('Compacting for 3s')
    expect(frame).toContain('esc to interrupt')
  })

  it('never counts backwards when the clock lags the start', async () => {
    const frame = await frameOf(overlay({ now: STARTED_AT - 500 }), 80)

    expect(frame).toContain('Compacting for 0s')
    expect(frame).not.toContain('for -')
  })

  it('says it is stopping once the operator asks it to', async () => {
    const frame = await frameOf(overlay({ cancelling: true }), 80)

    expect(frame).toContain('Interrupting')
    expect(frame).not.toContain('Compacting for')
  })

  it('rises from the bottom rather than floating over the middle', async () => {
    const rows = (await frameOf(overlay(), 80)).replace(/\n$/, '').split('\n')
    const edge = rows.findIndex((row) => row.trimEnd().startsWith('─'))

    expect(edge).toBeGreaterThan(rows.length / 2)
    expect(rows.slice(edge).some((row) => row.includes('Compacting for'))).toBe(true)
  })

  it('rules off the whole width, so it reads as a card and not a message', async () => {
    const rows = (await frameOf(overlay(), 80)).replace(/\n$/, '').split('\n')
    const edge = rows.find((row) => row.trimEnd().startsWith('─')) ?? ''

    expect(edge.trimEnd()).toHaveLength(80)
  })

  it('stands tall enough to be a card, with room around what it says', async () => {
    const rows = (await frameOf(overlay(), 80)).replace(/\n$/, '').split('\n')
    const edge = rows.findIndex((row) => row.trimEnd().startsWith('─'))

    expect(rows.length - edge).toBeGreaterThanOrEqual(7)
  })

  it('says what compaction is about to do to the conversation', async () => {
    const frame = await frameOf(overlay(), 80)

    expect(frame).toContain('COMPACTING')
    expect(frame).toContain('Every row stays in the transcript')
  })

  it('mounts at a narrow width without spilling', async () => {
    await expect(
      mount(
        <CompactingOverlay
          compacting={{ startedAt: STARTED_AT, cancelling: false }}
          now={STARTED_AT + 3_000}
          width={40}
        />,
        40,
      ),
    ).resolves.toBeUndefined()
  })
})
