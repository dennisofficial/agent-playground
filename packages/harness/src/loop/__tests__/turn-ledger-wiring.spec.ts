import { afterEach, describe, expect, it } from 'bun:test'

import { defaultPipeline, EMPTY_PROMPT, type ModelPort } from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, LoopTurnRunner, TurnRunner, type AtlasHarness } from '..'
import { TurnLedgerPort, type TurnSpend } from '../../ledger'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

type RecordingLedger = TurnLedgerPort & { recorded: TurnSpend[] }

function recordingLedger(args: { failWith?: Error } = {}): RecordingLedger {
  const recorded: TurnSpend[] = []

  return {
    recorded,
    record: async (spend) => {
      if (args.failWith !== undefined) throw args.failWith
      recorded.push(spend)
    },
    forThread: async () => [...recorded],
    forThreadTree: async () => ({ own: [...recorded], delegated: [] }),
  }
}

async function openHarness(script: readonly ScriptedStep[]): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model: scriptedModel({ script }) })
  opened.push({ harness, temp })
  return harness
}

function runnerOver(args: {
  harness: AtlasHarness
  ledger: TurnLedgerPort
  model?: ModelPort
  onLedgerFailure?: (error: unknown) => void
}): TurnRunner {
  return new LoopTurnRunner({
    log: args.harness.log,
    model: args.model ?? args.harness.model,
    ids: args.harness.ids,
    assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
    spend: {
      ledger: args.ledger,
      clock: args.harness.clock,
      ...(args.onLedgerFailure === undefined ? {} : { onLedgerFailure: args.onLedgerFailure }),
    },
  })
}

const throwingModel = (identity: ModelPort['identity'], error: Error): ModelPort => ({
  identity,
  step: async () => {
    throw error
  },
})

describe('every way a turn can end reaches the ledger', () => {
  it('records a completed turn with the status it returned', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }])
    const ledger = recordingLedger()
    const thread = await harness.threads.create({})

    const outcome = await runnerOver({ harness, ledger }).say({
      threadId: thread.id,
      text: 'what changed?',
    })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(ledger.recorded).toHaveLength(1)
    expect(ledger.recorded[0]).toMatchObject({
      threadId: thread.id,
      status: ETurnStatus.Completed,
      steps: 1,
    })
  })

  it('records a turn that threw out of the loop as crashed, and still lets the throw through', async () => {
    const harness = await openHarness([{ text: 'never reached' }])
    const ledger = recordingLedger()
    const thread = await harness.threads.create({})
    const runner = runnerOver({
      harness,
      ledger,
      model: throwingModel(harness.model.identity, new Error('the loop threw')),
    })

    await expect(runner.say({ threadId: thread.id, text: 'what changed?' })).rejects.toThrow('the loop threw')

    expect(ledger.recorded).toHaveLength(1)
    expect(ledger.recorded[0]?.status).toBe('crashed')
  })

  it('separates a crash from a returned failure', async () => {
    const harness = await openHarness([{ text: 'never reached' }])
    const ledger = recordingLedger()
    const thread = await harness.threads.create({})
    const runner = runnerOver({
      harness,
      ledger,
      model: throwingModel(harness.model.identity, new Error('the loop threw')),
    })

    await expect(runner.say({ threadId: thread.id, text: 'go' })).rejects.toThrow()

    expect(ledger.recorded[0]?.status).not.toBe(ETurnStatus.Failed)
  })

  it('leaves no row for a turn that never reached the model', async () => {
    const harness = await openHarness([{ text: 'unused' }])
    const ledger = recordingLedger()
    const thread = await harness.threads.create({})

    const outcome = await runnerOver({ harness, ledger }).runTurn({ threadId: thread.id })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(ledger.recorded).toHaveLength(0)
  })

  it('writes one row per turn rather than one per step or one per thread', async () => {
    const harness = await openHarness([{ text: 'first' }, { text: 'second' }])
    const ledger = recordingLedger()
    const thread = await harness.threads.create({})
    const runner = runnerOver({ harness, ledger })

    await runner.say({ threadId: thread.id, text: 'one' })
    await runner.say({ threadId: thread.id, text: 'two' })

    expect(ledger.recorded).toHaveLength(2)
    expect(new Set(ledger.recorded.map((spend) => spend.runId)).size).toBe(2)
  })

  it('carries the tokens the steps were billed onto the row', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }])
    const ledger = recordingLedger()
    const thread = await harness.threads.create({})

    await runnerOver({ harness, ledger }).say({ threadId: thread.id, text: 'what changed?' })

    const spend = ledger.recorded[0]
    expect(spend).toBeDefined()
    expect(spend?.inputTokens).toBeGreaterThan(0)
    expect(spend?.durationMs).toBeGreaterThanOrEqual(0)
    expect(spend?.providerId).toBe(harness.model.identity.id)
    expect(spend?.modelId).toBe(harness.model.identity.modelId)
  })
})

describe('the ledger is accounting, not the turn', () => {
  it('completes the turn even though the ledger write rejected', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }])
    const failures: unknown[] = []
    const ledger = recordingLedger({ failWith: new Error('disk is gone') })
    const thread = await harness.threads.create({})

    const outcome = await runnerOver({
      harness,
      ledger,
      onLedgerFailure: (error) => failures.push(error),
    }).say({ threadId: thread.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(failures).toHaveLength(1)
  })

  it('runs the same wrapper with no ledger bound at all', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }])
    const thread = await harness.threads.create({})

    const runner = new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
    })

    const outcome = await runner.say({ threadId: thread.id, text: 'what changed?' })
    expect(outcome.status).toBe(ETurnStatus.Completed)
  })
})
