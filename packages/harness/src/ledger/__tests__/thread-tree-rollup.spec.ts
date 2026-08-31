import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EForkMode, toRunId, type RunId, type ThreadId } from '@dltech/atlas-core'

import { openAtlasDatabase, PrismaThreadStore, RandomIds, SystemClock } from '../../store'
import { PrismaTurnLedger } from '../prisma-turn-ledger'
import { SupervisionTreeTooDeep } from '../spawned-threads'
import { tallyThreadTreeSpend } from '../thread-tree-spend'
import type { TurnSpend } from '../turn-ledger.port'

type Tree = {
  ledger: PrismaTurnLedger
  threads: PrismaThreadStore
  close: () => Promise<void>
}

const open = async (): Promise<Tree> => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-rollup-'))
  const database = await openAtlasDatabase({ databaseUrl: `file:${join(directory, 'harness.db')}` })
  const tree: Tree = {
    ledger: new PrismaTurnLedger(database.prisma),
    threads: new PrismaThreadStore(database.prisma, new SystemClock(), new RandomIds()),
    close: async () => {
      await database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  opened.push(tree)
  return tree
}

const opened: Tree[] = []

afterEach(async () => {
  for (const tree of opened.splice(0)) await tree.close()
})

let minted = 0
const nextRunId = (): RunId => {
  minted += 1
  return toRunId(`run-${minted}`)
}

const spendOf = ({
  threadId,
  startedAt = '2026-08-26T10:00:00.000Z',
  steps = 3,
  inputTokens = 42_000,
}: {
  threadId: ThreadId
  startedAt?: string
  steps?: number
  inputTokens?: number
}): TurnSpend => ({
  runId: nextRunId(),
  threadId,
  status: 'completed',
  providerId: 'anthropic',
  modelId: 'claude-opus-5',
  steps,
  inputTokens,
  outputTokens: 1_200,
  cacheReadTokens: 38_000,
  cacheWriteTokens: 2_500,
  startedAt,
  endedAt: '2026-08-26T10:00:12.000Z',
  durationMs: 12_000,
})

const runIdsOf = (rows: readonly TurnSpend[]): string[] => rows.map((row) => row.runId)

describe('spend rolled up across a thread and the agents it spawned', () => {
  it('gives a childless thread its own spend and nothing delegated', async () => {
    const { ledger, threads } = await open()
    const thread = await threads.create({})
    const spend = spendOf({ threadId: thread.id })

    await ledger.record(spend)

    expect(await ledger.forThreadTree({ threadId: thread.id })).toEqual({
      own: [spend],
      delegated: [],
    })
  })

  it('counts every sub-agent it spawned, and no other thread', async () => {
    const { ledger, threads } = await open()
    const parent = await threads.create({})
    const researcher = await threads.create({
      agent: { spawnedBy: parent.id, type: 'researcher' },
    })
    const reviewer = await threads.create({ agent: { spawnedBy: parent.id, type: 'reviewer' } })
    const stranger = await threads.create({})
    const strangersChild = await threads.create({
      agent: { spawnedBy: stranger.id, type: 'researcher' },
    })

    const own = spendOf({ threadId: parent.id, startedAt: '2026-08-26T10:00:00.000Z' })
    const first = spendOf({ threadId: researcher.id, startedAt: '2026-08-26T10:00:01.000Z' })
    const second = spendOf({ threadId: reviewer.id, startedAt: '2026-08-26T10:00:02.000Z' })
    const elsewhere = spendOf({ threadId: strangersChild.id })
    for (const spend of [own, first, second, elsewhere]) await ledger.record(spend)

    const rolled = await ledger.forThreadTree({ threadId: parent.id })

    expect(rolled.own).toEqual([own])
    expect(rolled.delegated).toEqual([first, second])
  })

  it('leaves a fork of the thread out of the delegated side', async () => {
    const { ledger, threads } = await open()
    const parent = await threads.create({})
    const fork = await threads.fork({ from: parent.id, seq: 0, mode: EForkMode.Reference })

    const own = spendOf({ threadId: parent.id })
    const onTheFork = spendOf({ threadId: fork.id })
    await ledger.record(own)
    await ledger.record(onTheFork)

    expect(await ledger.forThreadTree({ threadId: parent.id })).toEqual({
      own: [own],
      delegated: [],
    })
  })

  it('reads a sub-agent thread on its own as spend it owns', async () => {
    const { ledger, threads } = await open()
    const parent = await threads.create({})
    const child = await threads.create({ agent: { spawnedBy: parent.id, type: 'researcher' } })
    const spend = spendOf({ threadId: child.id })

    await ledger.record(spend)

    expect(await ledger.forThreadTree({ threadId: child.id })).toEqual({
      own: [spend],
      delegated: [],
    })
  })

  it('orders each side the way forThread does, oldest turn first', async () => {
    const { ledger, threads } = await open()
    const parent = await threads.create({})
    const child = await threads.create({ agent: { spawnedBy: parent.id, type: 'researcher' } })

    const late = spendOf({ threadId: parent.id, startedAt: '2026-08-26T12:00:00.000Z' })
    const early = spendOf({ threadId: parent.id, startedAt: '2026-08-26T09:00:00.000Z' })
    const lateChild = spendOf({ threadId: child.id, startedAt: '2026-08-26T11:00:00.000Z' })
    const earlyChild = spendOf({ threadId: child.id, startedAt: '2026-08-26T10:00:00.000Z' })
    for (const spend of [late, early, lateChild, earlyChild]) await ledger.record(spend)

    const rolled = await ledger.forThreadTree({ threadId: parent.id })

    expect(runIdsOf(rolled.own)).toEqual(runIdsOf([early, late]))
    expect(runIdsOf(rolled.delegated)).toEqual(runIdsOf([earlyChild, lateChild]))
    expect(rolled.own).toEqual(await ledger.forThread({ threadId: parent.id }))
  })

  it('refuses to answer rather than under-count when a sub-agent has spawned its own', async () => {
    const { ledger, threads } = await open()
    const parent = await threads.create({})
    const child = await threads.create({ agent: { spawnedBy: parent.id, type: 'researcher' } })
    const grandchild = await threads.create({
      agent: { spawnedBy: child.id, type: 'researcher' },
    })
    await ledger.record(spendOf({ threadId: grandchild.id }))

    await expect(ledger.forThreadTree({ threadId: parent.id })).rejects.toThrow(
      SupervisionTreeTooDeep,
    )
  })

  it('adds up to a total the caller can show beside the split', async () => {
    const { ledger, threads } = await open()
    const parent = await threads.create({})
    const child = await threads.create({ agent: { spawnedBy: parent.id, type: 'researcher' } })

    await ledger.record(spendOf({ threadId: parent.id, steps: 2, inputTokens: 1_000 }))
    await ledger.record(spendOf({ threadId: child.id, steps: 5, inputTokens: 7_000 }))
    await ledger.record(spendOf({ threadId: child.id, steps: 1, inputTokens: 500 }))

    const totals = tallyThreadTreeSpend(await ledger.forThreadTree({ threadId: parent.id }))

    expect(totals.own.turns).toBe(1)
    expect(totals.own.inputTokens).toBe(1_000)
    expect(totals.delegated.turns).toBe(2)
    expect(totals.delegated.inputTokens).toBe(7_500)
    expect(totals.combined.turns).toBe(3)
    expect(totals.combined.steps).toBe(8)
    expect(totals.combined.inputTokens).toBe(8_500)
  })
})
