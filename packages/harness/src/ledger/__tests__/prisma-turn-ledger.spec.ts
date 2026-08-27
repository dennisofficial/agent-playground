import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toRunId, type BranchId, type RunId } from '@dltech/atlas-core'

import { openAtlasDatabase, PrismaBranchStore, RandomIds, SystemClock } from '../../store'
import { PrismaTurnLedger } from '../prisma-turn-ledger'
import type { TurnSpend } from '../turn-ledger.port'

type OpenLedger = {
  ledger: PrismaTurnLedger
  branchId: BranchId
  close: () => Promise<void>
}

const opened: OpenLedger[] = []

async function open(): Promise<OpenLedger> {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-ledger-'))
  const database = await openAtlasDatabase({ databaseUrl: `file:${join(directory, 'harness.db')}` })
  const branch = await new PrismaBranchStore(database.prisma, new SystemClock(), new RandomIds()).create({})

  const entry: OpenLedger = {
    ledger: new PrismaTurnLedger(database.prisma),
    branchId: branch.id,
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

const spendOf = (args: { branchId: BranchId; runId: RunId; status: string }): TurnSpend => ({
  runId: args.runId,
  branchId: args.branchId,
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
    const { ledger, branchId } = await open()
    const spend = spendOf({ branchId, runId: toRunId('run-1'), status: 'completed' })

    await ledger.record(spend)

    expect(await ledger.forBranch({ branchId })).toEqual([spend])
  })

  it('records the terminal status a turn actually reached', async () => {
    const { ledger, branchId } = await open()

    await ledger.record(spendOf({ branchId, runId: toRunId('run-1'), status: 'interrupted' }))
    await ledger.record(spendOf({ branchId, runId: toRunId('run-2'), status: 'failed' }))

    expect((await ledger.forBranch({ branchId })).map((spend) => spend.status)).toEqual([
      'interrupted',
      'failed',
    ])
  })

  it('keeps one row per run rather than doubling it when a write is replayed', async () => {
    const { ledger, branchId } = await open()
    const spend = spendOf({ branchId, runId: toRunId('run-1'), status: 'completed' })

    await ledger.record(spend)
    await ledger.record({ ...spend, steps: 4, outputTokens: 1_500 })

    const rows = await ledger.forBranch({ branchId })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.steps).toBe(4)
  })

  it('arrives on a database that only ever had branches and events, leaving them standing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-ledger-upgrade-'))
    const databaseUrl = `file:${join(directory, 'harness.db')}`
    const before = await openAtlasDatabase({ databaseUrl })
    const branch = await new PrismaBranchStore(before.prisma, new SystemClock(), new RandomIds()).create({
      title: 'written before the ledger existed',
    })
    await before.close()

    const after = await openAtlasDatabase({ databaseUrl })
    try {
      const ledger = new PrismaTurnLedger(after.prisma)
      await ledger.record(spendOf({ branchId: branch.id, runId: toRunId('run-1'), status: 'completed' }))

      expect(await ledger.forBranch({ branchId: branch.id })).toHaveLength(1)
      expect((await after.prisma.branch.findUnique({ where: { id: branch.id } }))?.title).toBe(
        'written before the ledger existed',
      )
    } finally {
      await after.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves the branches of other turns out of the answer', async () => {
    const first = await open()
    const second = await open()

    await first.ledger.record(
      spendOf({ branchId: first.branchId, runId: toRunId('run-1'), status: 'completed' }),
    )

    expect(await second.ledger.forBranch({ branchId: second.branchId })).toEqual([])
  })
})
