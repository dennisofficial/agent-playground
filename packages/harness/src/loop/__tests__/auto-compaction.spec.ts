import { afterEach, describe, expect, it } from 'bun:test'

import { ECompactionAnchor } from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { scriptedModel } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

const HAIKU_WINDOW = 200_000

const HUGE = 'x'.repeat(4 * (HAIKU_WINDOW + 10_000))

async function openWith(
  compact?: () => Promise<boolean>,
  atPercent = 90,
): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [{ text: 'done' }] }),
    identity: { id: 'anthropic', modelId: 'claude-haiku-4-5' },
    autoCompactAtPercent: () => atPercent,
    ...(compact === undefined ? {} : { compact }),
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
    const harness = await openWith(async () => {
      asked += 1
      const thread = await harness.threads.mostRecent()
      if (thread === undefined) return false

      await harness.threads.compact({
        threadId: thread.id,
        anchor: ECompactionAnchor.Prefix,
        fromSeq: 1,
        throughSeq: 2,
        summary: 'the operator pasted something enormous and it was read',
      })
      return true
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

  it('asks only once, so a compaction that did not help cannot spin the turn', async () => {
    let asked = 0
    const harness = await openWith(async () => {
      asked += 1
      return true
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
    const harness = await openWith(async () => {
      asked += 1
      return true
    }, 0)

    const thread = await harness.threads.create({})
    const outcome = await harness.runner.say({ threadId: thread.id, text: HUGE })

    expect(asked).toBe(0)
    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed && outcome.message).toContain('/compact')
  }, 30_000)

  it('leaves an ordinary turn alone', async () => {
    let asked = 0
    const harness = await openWith(async () => {
      asked += 1
      return true
    })

    const thread = await harness.threads.create({})
    await harness.runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(asked).toBe(0)
  }, 30_000)
})
