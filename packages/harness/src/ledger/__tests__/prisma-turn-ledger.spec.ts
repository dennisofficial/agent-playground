import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toRunId, type ThreadId, type RunId } from '@dltech/atlas-core'

import { openAtlasDatabase, PrismaThreadStore, RandomIds, SystemClock } from '../../store'
import { PrismaTurnLedger } from '../prisma-turn-ledger'
import type { TurnSpend } from '../turn-ledger.port'

type OpenLedger = {
  ledger: PrismaTurnLedger
  threadId: ThreadId
  close: () => Promise<void>
}

const opened: OpenLedger[] = []

async function open(): Promise<OpenLedger> {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-ledger-'))
  const database = await openAtlasDatabase({ databaseUrl: `file:${join(directory, 'harness.db')}` })
  const thread = await new PrismaThreadStore(database.prisma, new SystemClock(), new RandomIds()).create({})

  const entry: OpenLedger = {
    ledger: new PrismaTurnLedger(database.prisma),
    threadId: thread.id,
    close: async () => {
      await database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  opened.push(entry)
  return entry
}

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

const spendOf = (args: { threadId: ThreadId; runId: RunId; status: string }): TurnSpend => ({
  runId: args.runId,
  threadId: args.threadId,
  status: args.status,
  providerId: 'anthropic',
  modelId: 'claude-opus-5',
  steps: 3,
  inputTokens: 42_000,
  outputTokens: 1_200,
  cacheReadTokens: 38_000,
  cacheWriteTokens: 2_500,
  startedAt: '2026-08-26T10:00:00.000Z',
  endedAt: '2026-08-26T10:00:12.000Z',
  durationMs: 12_000,
})

describe('the turn ledger over a real database', () => {
  it('reads back every field it was given', async () => {
    const { ledger, threadId } = await open()
    const spend = spendOf({ threadId, runId: toRunId('run-1'), status: 'completed' })

    await ledger.record(spend)

    expect(await ledger.forThread({ threadId })).toEqual([spend])
  })

  it('records the terminal status a turn actually reached', async () => {
    const { ledger, threadId } = await open()

    await ledger.record(spendOf({ threadId, runId: toRunId('run-1'), status: 'interrupted' }))
    await ledger.record(spendOf({ threadId, runId: toRunId('run-2'), status: 'failed' }))

    expect((await ledger.forThread({ threadId })).map((spend) => spend.status)).toEqual([
      'interrupted',
      'failed',
    ])
  })

  it('keeps one row per run rather than doubling it when a write is replayed', async () => {
    const { ledger, threadId } = await open()
    const spend = spendOf({ threadId, runId: toRunId('run-1'), status: 'completed' })

    await ledger.record(spend)
    await ledger.record({ ...spend, steps: 4, outputTokens: 1_500 })

    const rows = await ledger.forThread({ threadId })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.steps).toBe(4)
  })

  it('arrives on a database that only ever had threads and events, leaving them standing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-ledger-upgrade-'))
    const databaseUrl = `file:${join(directory, 'harness.db')}`
    const before = await openAtlasDatabase({ databaseUrl })
    const thread = await new PrismaThreadStore(before.prisma, new SystemClock(), new RandomIds()).create({
      title: 'written before the ledger existed',
    })
    await before.close()

    const after = await openAtlasDatabase({ databaseUrl })
    try {
      const ledger = new PrismaTurnLedger(after.prisma)
      await ledger.record(spendOf({ threadId: thread.id, runId: toRunId('run-1'), status: 'completed' }))

      expect(await ledger.forThread({ threadId: thread.id })).toHaveLength(1)
      expect((await after.prisma.thread.findUnique({ where: { id: thread.id } }))?.title).toBe(
        'written before the ledger existed',
      )
    } finally {
      await after.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves the threads of other turns out of the answer', async () => {
    const first = await open()
    const second = await open()

    await first.ledger.record(
      spendOf({ threadId: first.threadId, runId: toRunId('run-1'), status: 'completed' }),
    )

    expect(await second.ledger.forThread({ threadId: second.threadId })).toEqual([])
  })
})
