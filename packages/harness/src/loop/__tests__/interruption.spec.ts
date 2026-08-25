import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'

import type { BranchId, Event } from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { interruptibleModel } from '../../model/testing/interruptible-model'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

const HEAD = 'auth and the router'
const TAIL = ' and everything else nobody waited for'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

type Interruptible = {
  harness: AtlasHarness
  model: MockLanguageModelV4
  branchId: BranchId
  interruption: AbortSignal
}

async function openArmed(): Promise<Interruptible> {
  const temp = createTempDatabase()
  const model = interruptibleModel({ head: HEAD, tail: TAIL })
  const controller = new AbortController()
  let armed = true

  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model,
    onChunk: (chunk) => {
      if (armed && chunk.type === 'text-delta') {
        armed = false
        controller.abort()
      }
      return chunk
    },
  })

  opened.push({ harness, temp })
  const branch = await harness.branches.create({})
  return { harness, model, branchId: branch.id, interruption: controller.signal }
}

async function openWith(script: readonly ScriptedStep[]): Promise<{ harness: AtlasHarness; branchId: BranchId }> {
  const temp = createTempDatabase()
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model: scriptedModel({ script }) })
  opened.push({ harness, temp })
  const branch = await harness.branches.create({})
  return { harness, branchId: branch.id }
}

const assistantTurns = (events: readonly Event[]) => events.filter((event) => event.type === 'assistant-said')

describe('interrupting a streaming reply', () => {
  it('keeps what had already streamed as one assistant turn marked interrupted', async () => {
    const armed = await openArmed()

    const outcome = await armed.harness.runner.say({
      branchId: armed.branchId,
      text: 'what changed?',
      signal: armed.interruption,
    })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    const events = await armed.harness.log.read({ branchId: armed.branchId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])

    const [reply] = assistantTurns(events)
    if (reply?.type !== 'assistant-said') throw new Error('the branch holds no assistant turn')
    expect(reply.parts).toEqual([{ type: 'text', text: HEAD }])
    expect(reply.interrupted).toBe(true)
  })

  it('appends nothing when the abort landed before any text arrived', async () => {
    const { harness, branchId } = await openWith([{ text: 'unreachable' }])
    const controller = new AbortController()
    controller.abort()

    const outcome = await harness.runner.say({ branchId, text: 'what changed?', signal: controller.signal })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    const events = await harness.log.read({ branchId })
    expect(events.map((event) => event.type)).toEqual(['user-said'])
  })

  it('waits for input on the next turn rather than re-asking', async () => {
    const armed = await openArmed()
    await armed.harness.runner.say({ branchId: armed.branchId, text: 'what changed?', signal: armed.interruption })
    const asked = armed.model.doStreamCalls.length

    const outcome = await armed.harness.runner.runTurn({ branchId: armed.branchId })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(armed.model.doStreamCalls).toHaveLength(asked)
    const events = await armed.harness.log.read({ branchId: armed.branchId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })

  it('renders the interrupted turn back to the model unchanged', async () => {
    const armed = await openArmed()
    await armed.harness.runner.say({ branchId: armed.branchId, text: 'what changed?', signal: armed.interruption })

    const outcome = await armed.harness.runner.say({ branchId: armed.branchId, text: 'go on' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    const prompt = armed.model.doStreamCalls[1]?.prompt ?? []
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])

    const replayed = prompt[2]
    if (replayed?.role !== 'assistant') throw new Error('the prompt replayed no assistant turn')
    expect(replayed.content).toEqual([{ type: 'text', text: HEAD }])
  })
})
