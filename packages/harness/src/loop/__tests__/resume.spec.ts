import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'

import type { BranchId } from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

let live: TempDatabase | undefined

afterEach(() => {
  live?.discard()
  live = undefined
})

async function attach(script: readonly ScriptedStep[]): Promise<{
  harness: AtlasHarness
  model: MockLanguageModelV4
  release: () => Promise<void>
}> {
  const temp = (live ??= createTempDatabase())
  const model = scriptedModel({ script })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  return { harness, model, release: harness.close }
}

const promptText = (model: MockLanguageModelV4, call: number): string =>
  JSON.stringify(model.doStreamCalls[call]?.prompt ?? [])

describe('a conversation that outlives the process that started it', () => {
  it('continues from nothing but the database file, driven by a different script', async () => {
    const first = await attach([{ text: 'auth and the router' }])
    const branch = await first.harness.branches.create({})
    const opened = await first.harness.runner.say({ branchId: branch.id, text: 'what changed?' })
    expect(opened.status).toBe(ETurnStatus.Completed)
    await first.release()

    const second = await attach([{ text: 'because the token expired' }])
    const recovered = await second.harness.branches.mostRecent()
    if (recovered === undefined) throw new Error('the database remembered no branch')

    const outcome = await second.harness.runner.say({ branchId: recovered.id, text: 'why?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(promptText(second.model, 0)).toContain('what changed?')
    expect(promptText(second.model, 0)).toContain('auth and the router')

    const events = await second.harness.log.read({ branchId: recovered.id })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'user-said',
      'assistant-said',
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    const reply = events.at(-1)
    expect(reply?.type === 'assistant-said' ? reply.parts : []).toEqual([
      { type: 'text', text: 'because the token expired' },
    ])
    await second.release()
  })

  it('finishes a reply the previous process died before writing', async () => {
    const first = await attach([])
    const branch: BranchId = (await first.harness.branches.create({})).id
    await first.harness.log.append({
      branchId: branch,
      runId: first.harness.ids.nextRunId(),
      drafts: [{ type: 'user-said', text: 'what changed?' }],
    })
    await first.release()

    const second = await attach([{ text: 'auth and the router' }])
    const outcome = await second.harness.runner.runTurn({ branchId: branch })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(promptText(second.model, 0)).toContain('what changed?')
    const events = await second.harness.log.read({ branchId: branch })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
    await second.release()
  })

  it('carries a thinking signature written by one process into the next process prompt', async () => {
    const first = await attach([{ reasoning: { text: 'checking the diff', signature: 'sig-abc' }, text: 'two files' }])
    const branch = (await first.harness.branches.create({})).id
    await first.harness.runner.say({ branchId: branch, text: 'what changed?' })
    await first.release()

    const second = await attach([{ text: 'because the token expired' }])
    await second.harness.runner.say({ branchId: branch, text: 'why?' })

    expect(promptText(second.model, 0)).toContain('sig-abc')
    await second.release()
  })

  it('does nothing on a reopened branch whose last word was the model', async () => {
    const first = await attach([{ text: 'auth and the router' }])
    const branch = (await first.harness.branches.create({})).id
    await first.harness.runner.say({ branchId: branch, text: 'what changed?' })
    await first.release()

    const second = await attach([{ text: 'unreachable' }])
    const outcome = await second.harness.runner.runTurn({ branchId: branch })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(second.model.doStreamCalls).toHaveLength(0)
    await second.release()
  })
})
