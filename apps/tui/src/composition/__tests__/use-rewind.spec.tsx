import {
  ECompactionAnchor,
  stampEvent,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'
import { KeyEvent } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import {
  ERewindPointKind,
  ERewindVerb,
  isCurrentRow,
  type RewindChoice,
  type RewindState,
} from '../../ui/rewind-model'
import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { useRewind, type RewindControl } from '../use-rewind'

const THREAD = toThreadId('rewinding')

const AT = '2026-08-27T00:00:00.000Z'

const stamped = (drafts: readonly EventDraft[]): Event[] =>
  drafts.map((draft, index) =>
    stampEvent({
      draft,
      envelope: {
        id: toEventId(`event-${index + 1}`),
        seq: index + 1,
        threadId: THREAD,
        runId: toRunId('run-1'),
        depth: 0,
        at: AT,
      },
    }),
  )

const compaction: EventDraft = {
  type: 'history-compacted',
  anchor: ECompactionAnchor.Prefix,
  fromSeq: 1,
  throughSeq: 2,
  summary: 'they asked for the loop and got it',
  replaced: 2,
}

const EXCHANGES: readonly EventDraft[] = [
  { type: 'user-said', text: 'first' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'answered first' }] },
  { type: 'user-said', text: 'second' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'answered second' }] },
  { type: 'user-said', text: 'third' },
]

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

const EMPTY: RewindState = { points: [], index: 0, verb: null }

type Probe = { control: RewindControl | null; picks: RewindChoice[] }

function Picker(props: { probe: Probe; events: readonly Event[] }): React.ReactNode {
  const control = useRewind({
    events: () => props.events,
    onPick: (choice) => props.probe.picks.push(choice),
  })
  props.probe.control = control

  return <text>{control.state === null ? 'closed' : `open ${control.state.index}`}</text>
}

const controlOf = (probe: Probe): RewindControl => {
  if (probe.control === null) throw new Error('the probe never mounted')
  return probe.control
}

async function mounted(drafts: readonly EventDraft[] = EXCHANGES): Promise<{
  probe: Probe
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  const probe: Probe = { control: null, picks: [] }
  const setup = await testRender(<Picker probe={probe} events={stamped(drafts)} />, {
    width: 60,
    height: 6,
  })
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

describe('the rewind control', () => {
  it('starts closed', async () => {
    const { probe, done } = await mounted()

    try {
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('opens on the most recent thing the operator said', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      expect(controlOf(probe).state?.points.map((point) => point.text)).toEqual([
        'first',
        'second',
        'third',
      ])
      expect(controlOf(probe).state?.index).toBe(2)
    } finally {
      await done()
    }
  })

  it('stays closed when there is no message and no compaction to offer', async () => {
    const { probe, flush, done } = await mounted([
      { type: 'assistant-said', parts: [{ type: 'text', text: 'unprompted' }] },
    ])

    try {
      controlOf(probe).handleOpen()
      await flush()

      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('ignores every key while it is closed', async () => {
    const { probe, flush, done } = await mounted()

    try {
      for (const name of ['up', 'down', 'return', 'escape']) {
        controlOf(probe).handleKey(press(name))
        await flush()
        expect(controlOf(probe).state).toBeNull()
      }
      expect(probe.picks).toEqual([])
    } finally {
      await done()
    }
  })

  it('offers a compaction as a point of its own, with no composer text', async () => {
    const { probe, flush, done } = await mounted([
      { type: 'user-said', text: 'first' },
      compaction,
    ])

    try {
      controlOf(probe).handleOpen()
      await flush()

      expect(controlOf(probe).state?.points.map((point) => point.kind)).toEqual([
        ERewindPointKind.Said,
        ERewindPointKind.Compacted,
      ])
      expect(controlOf(probe).state?.points.at(-1)?.text).toBe('')
    } finally {
      await done()
    }
  })

  it('dismisses from the row that changes nothing, the way escape does', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      controlOf(probe).handleKey(press('down'))
      await flush()
      expect(isCurrentRow(controlOf(probe).state ?? EMPTY)).toBe(true)

      controlOf(probe).handleKey(press('return'))
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(probe.picks).toEqual([])
    } finally {
      await done()
    }
  })

  it('walks back in time on the up arrow', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      controlOf(probe).handleKey(press('up'))
      await flush()

      expect(controlOf(probe).state?.index).toBe(1)
    } finally {
      await done()
    }
  })

  it('takes two returns to do anything, not one', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      controlOf(probe).handleKey(press('return'))
      await flush()

      expect(controlOf(probe).state?.verb).toBe(ERewindVerb.ToHere)
      expect(probe.picks).toEqual([])

      controlOf(probe).handleKey(press('return'))
      await flush()

      expect(probe.picks).toEqual([
        {
          point: { kind: ERewindPointKind.Said, seq: 5, text: 'third' },
          verb: ERewindVerb.ToHere,
        },
      ])
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('moves between verbs once a verb stage is open', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      controlOf(probe).handleKey(press('up'))
      await flush()
      controlOf(probe).handleKey(press('return'))
      await flush()

      controlOf(probe).handleKey(press('down'))
      await flush()

      expect(controlOf(probe).state?.verb).toBe(ERewindVerb.SummariseUpTo)
      expect(controlOf(probe).state?.index).toBe(1)
    } finally {
      await done()
    }
  })

  it('steps escape back to the point stage instead of destroying anything', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      controlOf(probe).handleKey(press('return'))
      await flush()

      controlOf(probe).handleKey(press('escape'))
      await flush()

      expect(controlOf(probe).state?.verb).toBeNull()
      expect(controlOf(probe).state?.index).toBe(2)
      expect(probe.picks).toEqual([])

      controlOf(probe).handleKey(press('escape'))
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(probe.picks).toEqual([])
    } finally {
      await done()
    }
  })

  it('hands a pick out and closes, so a click resolves the same way a key does', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()

      const choice: RewindChoice = {
        point: { kind: ERewindPointKind.Said, seq: 1, text: 'first' },
        verb: ERewindVerb.SummariseFrom,
      }
      controlOf(probe).handlePick(choice)
      await flush()

      expect(probe.picks).toEqual([choice])
      expect(controlOf(probe).state).toBeNull()
    } finally {
      await done()
    }
  })

  it('closes on demand and reopens on the newest message', async () => {
    const { probe, flush, done } = await mounted()

    try {
      controlOf(probe).handleOpen()
      await flush()
      controlOf(probe).handleKey(press('up'))
      await flush()

      controlOf(probe).handleDismiss()
      await flush()

      expect(controlOf(probe).state).toBeNull()
      expect(probe.picks).toEqual([])

      controlOf(probe).handleOpen()
      await flush()

      expect(controlOf(probe).state?.index).toBe(2)
    } finally {
      await done()
    }
  })
})
