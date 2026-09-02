import { describe, expect, it } from 'bun:test'
import React from 'react'

import { ERiskDimension, toCallId, type GrantOffer } from '@dltech/atlas-core'

import {
  APPROVAL_EVIDENCE_HEADING,
  APPROVAL_HEADING,
  APPROVAL_OPTIONS,
  APPROVAL_REWIND_NOTE,
  EApprovalChoice,
} from '../approval-model'
import { Approval } from '../components/approval'
import { glyph } from '../theme'
import { frameOf, mount } from './transcript-fixture'

const WIDTH = 80

const CALL = toCallId('call-1')

const REASON = 'this would remove a worktree another session is standing in'

const drawer = (
  over: {
    reason?: string
    selected?: number
    evidence?: readonly string[]
    dimensions?: readonly ERiskDimension[]
    grantables?: readonly GrantOffer[]
  } = {},
) => (
  <Approval
    width={WIDTH}
    state={{
      callId: CALL,
      reason: over.reason ?? REASON,
      evidence: over.evidence ?? [],
      dimensions: over.dimensions ?? [],
      grantables: over.grantables ?? [],
      selected: over.selected ?? 0,
    }}
    overlay
    onPick={() => undefined}
    onDismiss={() => undefined}
  />
)

const rowsOf = (frame: string): string[] => frame.replace(/\n$/, '').split('\n')

const rowWith = (frame: string, text: string): string =>
  rowsOf(frame).find((row) => row.includes(text)) ?? ''

const labelOf = (choice: EApprovalChoice): string =>
  APPROVAL_OPTIONS.find((option) => option.choice === choice)?.label ?? ''

describe('the drawer that asks the operator to double-check a call', () => {
  it('says why it stopped, in the words the hook used', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    expect(frame).toContain(APPROVAL_HEADING)
    expect(frame).toContain(REASON)
  })

  it('offers both answers, numbered so they can be spoken about', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    APPROVAL_OPTIONS.forEach((option, index) => {
      expect(rowWith(frame, option.label)).toContain(`${String(index + 1)}. ${option.label}`)
    })
  })

  it('marks the selected answer and nothing else', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    expect(rowWith(frame, labelOf(EApprovalChoice.Proceed))).toContain(glyph.selected)
    expect(rowWith(frame, labelOf(EApprovalChoice.Decline))).not.toContain(glyph.selected)
  })

  it('moves the mark when the selection moves', async () => {
    const frame = await frameOf(drawer({ selected: 1 }), WIDTH)

    expect(rowWith(frame, labelOf(EApprovalChoice.Decline))).toContain(glyph.selected)
    expect(rowWith(frame, labelOf(EApprovalChoice.Proceed))).not.toContain(glyph.selected)
  })

  it('says which keys answer the question', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    expect(frame).toContain('Enter to proceed')
    expect(frame).toContain('Esc to decline')
  })

  it('offers the standing grant as a third line naming its subject', async () => {
    const frame = await frameOf(
      drawer({
        grantables: [
          { subject: 'worktree:eng-412-sidebar', dimensions: [ERiskDimension.Contention] },
        ],
      }),
      WIDTH,
    )

    expect(rowWith(frame, 'worktree:eng-412-sidebar')).toContain('2. Proceed, and stop asking')
    expect(rowWith(frame, labelOf(EApprovalChoice.Decline))).toContain('3. Decline')
    expect(frame).toContain('a to stop asking')
  })

  it('never shows a third line when the pause cannot be waived in advance', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    expect(frame).not.toContain('stop asking')
    expect(rowWith(frame, labelOf(EApprovalChoice.Decline))).toContain('2. Decline')
  })

  it('wraps a long reason inside the card rather than spilling past it', async () => {
    const frame = await frameOf(drawer({ reason: `${REASON} ${'and on '.repeat(20)}` }), WIDTH)

    for (const row of rowsOf(frame)) expect(row.trimEnd().length).toBeLessThanOrEqual(WIDTH)
    expect(frame).toContain('another session')
  })

  it('rises from the bottom rather than floating over the middle', async () => {
    const rows = rowsOf(await frameOf(drawer(), WIDTH))
    const edge = rows.findIndex((row) => row.trimEnd().startsWith('─'))

    expect(edge).toBeGreaterThan(rows.length / 2)
    expect(rows.slice(edge).some((row) => row.includes(APPROVAL_HEADING))).toBe(true)
  })

  it('mounts at a narrow width without spilling', async () => {
    await expect(
      mount(
        <Approval
          width={40}
          state={{
            callId: CALL,
            reason: REASON,
            evidence: ['the sibling worktree carries twelve uncommitted changes'],
            dimensions: [ERiskDimension.Contention],
            grantables: [],
            selected: 0,
          }}
          overlay
          onPick={() => undefined}
          onDismiss={() => undefined}
        />,
        40,
      ),
    ).resolves.toBeUndefined()
  })

  it('shows what each surviving probe saw, so the pause explains itself', async () => {
    const frame = await frameOf(
      drawer({
        evidence: [
          'eng-412-sidebar is held by another live session',
          'twelve uncommitted changes would go with it',
        ],
        dimensions: [ERiskDimension.Contention, ERiskDimension.Irreversibility],
      }),
      WIDTH,
    )

    expect(frame).toContain('eng-412-sidebar is held by another live session')
    expect(frame).toContain('twelve uncommitted changes would go with it')
  })

  it('names the dimensions that fired beside the evidence', async () => {
    const frame = await frameOf(
      drawer({ evidence: ['a probe said so'], dimensions: [ERiskDimension.Contention] }),
      WIDTH,
    )

    expect(rowWith(frame, APPROVAL_EVIDENCE_HEADING)).toContain(ERiskDimension.Contention)
  })

  it('keeps the evidence block out of the way when no probe wrote a line', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    expect(frame).not.toContain(APPROVAL_EVIDENCE_HEADING)
  })

  it('says that rewind is shut until the question is answered', async () => {
    const frame = await frameOf(drawer(), WIDTH)

    expect(frame).toContain('Rewind stays shut')
    expect(APPROVAL_REWIND_NOTE).toContain('Esc')
  })

  it('wraps a long evidence line inside the card rather than spilling past it', async () => {
    const frame = await frameOf(
      drawer({ evidence: [`the worktree ${'and on '.repeat(20)}`] }),
      WIDTH,
    )

    for (const row of rowsOf(frame)) expect(row.trimEnd().length).toBeLessThanOrEqual(WIDTH)
  })
})
