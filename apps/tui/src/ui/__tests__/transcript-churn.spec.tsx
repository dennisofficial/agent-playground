import { testRender } from '@opentui/react/test-utils'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import React, { act, useCallback, useState, useSyncExternalStore } from 'react'

import type { ConversationStore, EEntryKind as EntryKind, TranscriptModel } from '../../store'

const { EntryView: RealEntryView } = await import('../components/entry-view')

type RowProps = React.ComponentProps<typeof RealEntryView>

/**
 * Every row in the transcript is the memoized `EntryView`, so a render that survives the memo is
 * exactly a render whose props changed identity. The wrapper counts those — it is memoized with the
 * same default shallow compare, so its counts are the real component's counts. The real component
 * is captured BEFORE the mock lands: `mock.module` rewrites the namespace's live bindings, so a
 * wrapper that read `real.EntryView` at render time would find itself and recurse without end.
 */
const renders = new Map<string, number>()

const CountedRow = React.memo((props: RowProps): React.ReactNode => {
  renders.set(props.entry.key, (renders.get(props.entry.key) ?? 0) + 1)
  return <RealEntryView {...props} />
})

void mock.module('../components/entry-view', () => ({ EntryView: CountedRow }))

const { EEntryKind, createConversationStore, deriveTranscript } = await import('../../store')
const { createDeltaChannel } = await import('@dltech/atlas-harness')
const { fixtureThreadId } = await import('../../store/__tests__/fixture')
const { called, callId, clocked, result, said } = await import('../../store/__tests__/tool-fixture')
const { moreKey } = await import('../components/blocks/tool-run-expansion')
const { Transcript } = await import('../components/transcript')
const { grammarsReady, teardown } = await import('../markdown/__tests__/harness')
const { frameSettled } = await import('./waiting')

await grammarsReady()

const AT = '2026-08-26T12:00:00.000Z'

const WIDTH = 80

const HEIGHT = 30

const CWD = '/Users/dennis/Developer/atlas'

const NOW = 95_000

const NOTHING_OPEN: ReadonlySet<string> = new Set()

const totalRenders = (): number => [...renders.values()].reduce((sum, count) => sum + count, 0)

const thoughtThenSaid = (args: { thinking: string; text: string }) => ({
  type: 'assistant-said' as const,
  parts: [
    { type: 'reasoning' as const, text: args.thinking },
    { type: 'text' as const, text: args.text },
  ],
})

const TWO_RUNS = deriveTranscript({
  events: clocked([
    { draft: thoughtThenSaid({ thinking: 'weighing the approaches', text: 'Reading first.' }), at: AT },
    { draft: called({ n: 1, name: 'read', input: { path: 'a.ts' } }), at: AT },
    { draft: result({ n: 1, name: 'read', output: { lines: 10 } }), at: AT },
    { draft: said('Editing next.'), at: AT },
    { draft: called({ n: 2, name: 'edit', input: { path: 'b.ts' } }), at: AT },
    { draft: result({ n: 2, name: 'edit', output: { added: 1, removed: 0 } }), at: AT },
  ]),
  signals: [],
})

const entryOf = (args: { model: TranscriptModel; kind: EntryKind; at?: number }) => {
  const found = args.model.entries.filter((entry) => entry.kind === args.kind)
  const entry = found[args.at ?? 0]
  if (entry === undefined) throw new Error(`the fixture has no ${args.kind} entry`)
  return entry
}

type ToggleProbe = { toggle: ((key: string) => void) | null }

function TogglingTranscript(props: { model: TranscriptModel; probe: ToggleProbe }): React.ReactNode {
  const [opened, setOpened] = useState<ReadonlySet<string>>(NOTHING_OPEN)
  const handleToggle = useCallback((key: string) => {
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  props.probe.toggle = handleToggle

  return (
    <Transcript
      model={props.model}
      width={WIDTH}
      now={NOW}
      cwd={CWD}
      opened={opened}
      onToggle={handleToggle}
    />
  )
}

describe('toggling one row', () => {
  beforeEach(() => renders.clear())

  const mounted = (model: TranscriptModel) =>
    testRender(
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <TogglingTranscript model={model} probe={toggleProbe} />
      </box>,
      { width: WIDTH, height: HEIGHT },
    )

  const toggleProbe: ToggleProbe = { toggle: null }

  const toggle = async (args: {
    setup: { flush: () => Promise<void> }
    key: string
  }): Promise<void> => {
    await act(async () => {
      toggleProbe.toggle?.(args.key)
      await args.setup.flush()
    })
    await args.setup.flush()
  }

  it('re-renders the tool run whose detail opened, and no other row', async () => {
    const firstRun = entryOf({ model: TWO_RUNS, kind: EEntryKind.ToolsRan, at: 0 })
    const setup = await mounted(TWO_RUNS)
    try {
      await frameSettled({ setup })
      renders.clear()

      await toggle({ setup, key: moreKey(callId(1)) })

      expect(renders.get(firstRun.key)).toBe(1)
      expect(totalRenders()).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('re-renders the thinking row that opened and leaves both tool runs standing', async () => {
    const thought = entryOf({ model: TWO_RUNS, kind: EEntryKind.ModelThought })
    const setup = await mounted(TWO_RUNS)
    try {
      await frameSettled({ setup })
      renders.clear()

      await toggle({ setup, key: thought.key })

      expect(renders.get(thought.key)).toBe(1)
      expect(totalRenders()).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

function StoreDrivenTranscript(props: { store: ConversationStore }): React.ReactNode {
  const model = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  return <Transcript model={model} width={WIDTH} now={NOW} cwd={CWD} />
}

describe('a chunk landing in a settled transcript', () => {
  it('re-renders only the row the chunk lands in, as it grows', async () => {
    const channel = createDeltaChannel()
    const store = createConversationStore({
      channel,
      threadId: fixtureThreadId,
      events: clocked([
        { draft: { type: 'user-said', text: 'go' }, at: AT },
        { draft: said('on it'), at: AT },
      ]),
    })
    const settledKeys = store.getSnapshot().entries.map((entry) => entry.key)

    const setup = await testRender(
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <StoreDrivenTranscript store={store} />
      </box>,
      { width: WIDTH, height: HEIGHT },
    )
    try {
      await frameSettled({ setup })
      renders.clear()

      const publisher = channel.publisherFor({ threadId: fixtureThreadId })
      await act(async () => {
        publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'half' })
        await setup.flush()
      })
      await setup.flush()

      expect(totalRenders()).toBe(1)
      const streamingKey = [...renders.keys()][0]
      if (streamingKey === undefined) throw new Error('the chunk never painted a row')
      expect(settledKeys).not.toContain(streamingKey)

      renders.clear()
      await act(async () => {
        publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'way' })
        await setup.flush()
      })
      await setup.flush()

      expect(totalRenders()).toBe(1)
      expect(renders.has(streamingKey)).toBe(true)
    } finally {
      store.dispose()
      await teardown(setup)
    }
  }, 60_000)
})
