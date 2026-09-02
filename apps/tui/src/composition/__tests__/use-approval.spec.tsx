import {
  EDecision,
  EGrantScope,
  ERiskDimension,
  toCallId,
  type EventDraft,
  type GrantOffer,
} from '@dltech/atlas-core'
import { KeyEvent } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { EApprovalChoice, grantIdFor, type ApprovalQuestion } from '../../ui/approval-model'
import { useApproval, type ApprovalControl } from '../use-approval'

const CALL = toCallId('call-1')

const REASON = 'contention: eng-412-sidebar is held by another live session'

const QUESTION: ApprovalQuestion = {
  callId: CALL,
  reason: REASON,
  evidence: ['eng-412-sidebar carries twelve uncommitted changes'],
  dimensions: [ERiskDimension.Contention, ERiskDimension.Irreversibility],
}

const OFFERS: readonly GrantOffer[] = [
  { subject: 'worktree:eng-412-sidebar', dimensions: [ERiskDimension.Contention] },
]

const OFFERED: ApprovalQuestion = { ...QUESTION, grantables: OFFERS }

const press = (name: string): KeyEvent =>
  new KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: '',
    number: false,
    raw: '',
    eventType: 'press',
    source: 'raw',
  })

const RENDER_MS = 60

type Probe = { control: ApprovalControl | null; answered: EventDraft[][] }

function Drawer(props: { probe: Probe }): React.ReactNode {
  const control = useApproval({
    onAnswer: (drafts) => props.probe.answered.push([...drafts]),
  })
  props.probe.control = control

  return <text>{control.state === null ? 'closed' : 'open'}</text>
}

const controlOf = (probe: Probe): ApprovalControl => {
  if (probe.control === null) throw new Error('the probe never mounted')
  return probe.control
}

async function mounted(): Promise<{
  probe: Probe
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  const probe: Probe = { control: null, answered: [] }
  const setup = await testRender(<Drawer probe={probe} />, { width: 60, height: 6 })
  await setup.flush()

  return {
    probe,
    flush: async () => {
      await settle(RENDER_MS)
      await setup.flush()
    },
    done: () => teardown(setup),
  }
}

describe('the approval control', () => {
  it('opens on the question with the evidence the classifier gathered', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(QUESTION)
      await flush()

      expect(controlOf(probe).state?.reason).toBe(REASON)
      expect(controlOf(probe).state?.evidence).toEqual([
        'eng-412-sidebar carries twelve uncommitted changes',
      ])
      expect(controlOf(probe).state?.dimensions).toEqual([
        ERiskDimension.Contention,
        ERiskDimension.Irreversibility,
      ])
    } finally {
      await done()
    }
  })

  it('answers Deny on Esc, which is what frees rewind again', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(QUESTION)
      await flush()
      controlOf(probe).handleKey(press('escape'))
      await flush()

      expect(probe.answered).toEqual([
        [{ type: 'approval-answered', callId: CALL, decision: EDecision.Deny }],
      ])
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('answers the highlighted choice on Enter', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(QUESTION)
      await flush()
      controlOf(probe).handleKey(press('return'))
      await flush()

      expect(probe.answered).toEqual([
        [{ type: 'approval-answered', callId: CALL, decision: EDecision.Allow }],
      ])
    } finally {
      await done()
    }
  })

  it('walks down to the refusal before Enter takes it', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(QUESTION)
      await flush()
      controlOf(probe).handleKey(press('down'))
      await flush()
      controlOf(probe).handleKey(press('return'))
      await flush()

      expect(probe.answered).toEqual([
        [{ type: 'approval-answered', callId: CALL, decision: EDecision.Deny }],
      ])
    } finally {
      await done()
    }
  })

  it('keeps the evidence while the selection moves', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(QUESTION)
      await flush()
      controlOf(probe).handleKey(press('down'))
      await flush()

      expect(controlOf(probe).state?.evidence).toHaveLength(1)
    } finally {
      await done()
    }
  })

  it('takes the standing grant on a, in the same append as the answer', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(OFFERED)
      await flush()
      controlOf(probe).handleKey(press('a'))
      await flush()

      expect(probe.answered).toEqual([
        [
          { type: 'approval-answered', callId: CALL, decision: EDecision.Allow },
          {
            type: 'permission-granted',
            grantId: grantIdFor({ callId: CALL, subject: 'worktree:eng-412-sidebar' }),
            dimensions: [ERiskDimension.Contention],
            scope: EGrantScope.Thread,
            subject: 'worktree:eng-412-sidebar',
            reason: REASON,
          },
        ],
      ])
    } finally {
      await done()
    }
  })

  it('ignores a on a pause the classifier offered no grant for', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen(QUESTION)
      await flush()
      controlOf(probe).handleKey(press('a'))
      await flush()

      expect(probe.answered).toEqual([])
      expect(controlOf(probe).state).not.toBeNull()
    } finally {
      await done()
    }
  })

  it('answers nothing while no question is open', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleKey(press('escape'))
      controlOf(probe).handlePick(EApprovalChoice.Proceed)
      await flush()

      expect(probe.answered).toEqual([])
    } finally {
      await done()
    }
  })
})
