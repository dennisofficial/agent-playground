import { afterEach, describe, expect, it } from 'bun:test'

import {
  ECompactionAnchor,
  EImageTier,
  type ClockPort,
  type ModelCard,
  type ThreadId,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { scriptedModel } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

const HAIKU_WINDOW = 200_000

const HAIKU_CARD: ModelCard = {
  ref: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  label: 'haiku-4-5',
  api: 'anthropic',
  contextWindow: HAIKU_WINDOW,
  imageTier: EImageTier.Standard,
}

const HUGE = 'x'.repeat(4 * (HAIKU_WINDOW + 10_000))

type Compact = (args: { threadId: ThreadId }) => Promise<boolean>

const settableClock = (initial: string): ClockPort & { set: (at: string) => void } => {
  let at = initial
  return { now: () => at, set: (next: string) => (at = next) }
}

async function openWith(args?: {
  compact?: Compact
  atPercent?: number
  clock?: ClockPort
}): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [{ text: 'done' }] }),
    identity: { id: 'anthropic', modelId: 'claude-haiku-4-5' },
    card: HAIKU_CARD,
    autoCompactAtPercent: () => args?.atPercent ?? 90,
    ...(args?.compact === undefined ? {} : { compact: args.compact }),
    ...(args?.clock === undefined ? {} : { clock: args.clock }),
  })
  opened.push({ harness, temp })
  return harness
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe('a step whose prompt would overflow the window', () => {
  it('asks whoever can compact, and completes the turn once the prompt fits', async () => {
    let asked = 0
    const harness = await openWith({
      compact: async ({ threadId }) => {
        asked += 1
        await harness.threads.compact({
          threadId,
          anchor: ECompactionAnchor.Prefix,
          fromSeq: 1,
          throughSeq: 2,
          summary: 'the operator pasted something enormous and it was read',
        })
        return true
      },
    })

    const thread = await harness.threads.create({})
    await harness.log.append({
      threadId: thread.id,
      runId: harness.ids.nextRunId(),
      drafts: [
        { type: 'user-said', text: HUGE },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'read it' }] },
      ],
    })

    const outcome = await harness.runner.say({ threadId: thread.id, text: 'now summarise it' })

    expect(asked).toBe(1)
    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect((await harness.log.read({ threadId: thread.id })).some((e) => e.type === 'history-compacted')).toBe(true)
  }, 30_000)

  it('names the thread the turn is running, not whichever thread was written to last', async () => {
    const clock = settableClock('2026-01-01T00:00:00.000Z')
    let named: ThreadId | undefined
    let latestWhenAsked: ThreadId | undefined

    const harness = await openWith({
      clock,
      compact: async ({ threadId }) => {
        clock.set('2026-06-01T00:00:00.000Z')
        await harness.log.append({
          threadId: elsewhere.id,
          runId: harness.ids.nextRunId(),
          drafts: [{ type: 'user-said', text: 'a second window takes a message mid-turn' }],
        })

        named = threadId
        latestWhenAsked = (await harness.threads.mostRecent({ project: '/work' }))?.id
        return false
      },
    })

    const running = await harness.threads.create({ workspace: '/work' })
    const elsewhere = await harness.threads.create({ workspace: '/work' })

    await harness.runner.say({ threadId: running.id, text: HUGE })

    expect(latestWhenAsked).toBe(elsewhere.id)
    expect(named).toBe(running.id)
  }, 30_000)

  it('asks only once, so a compaction that did not help cannot spin the turn', async () => {
    let asked = 0
    const harness = await openWith({
      compact: async () => {
        asked += 1
        return true
      },
    })

    const thread = await harness.threads.create({})
    await harness.runner.say({ threadId: thread.id, text: HUGE })

    expect(asked).toBe(1)
  }, 30_000)

  it('stops the turn and names /compact when nothing can compact for it', async () => {
    const harness = await openWith()

    const thread = await harness.threads.create({})
    const outcome = await harness.runner.say({ threadId: thread.id, text: HUGE })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed && outcome.message).toContain('/compact')
  }, 30_000)

  it('does not compact behind the operator who turned the threshold off', async () => {
    let asked = 0
    const harness = await openWith({
      atPercent: 0,
      compact: async () => {
        asked += 1
        return true
      },
    })

    const thread = await harness.threads.create({})
    const outcome = await harness.runner.say({ threadId: thread.id, text: HUGE })

    expect(asked).toBe(0)
    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed && outcome.message).toContain('/compact')
  }, 30_000)

  it('leaves an ordinary turn alone', async () => {
    let asked = 0
    const harness = await openWith({
      compact: async () => {
        asked += 1
        return true
      },
    })

    const thread = await harness.threads.create({})
    await harness.runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(asked).toBe(0)
  }, 30_000)
})
