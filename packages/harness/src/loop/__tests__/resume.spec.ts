import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'

import type { ThreadId } from '@dltech/atlas-core'

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
    const thread = await first.harness.threads.create({ workspace: '/work' })
    const opened = await first.harness.runner.say({ threadId: thread.id, text: 'what changed?' })
    expect(opened.status).toBe(ETurnStatus.Completed)
    await first.release()

    const second = await attach([{ text: 'because the token expired' }])
    const recovered = await second.harness.threads.mostRecent({ project: '/work' })
    if (recovered === undefined) throw new Error('the database remembered no thread')

    const outcome = await second.harness.runner.say({ threadId: recovered.id, text: 'why?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(promptText(second.model, 0)).toContain('what changed?')
    expect(promptText(second.model, 0)).toContain('auth and the router')

    const events = await second.harness.log.read({ threadId: recovered.id })
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
    const thread: ThreadId = (await first.harness.threads.create({})).id
    await first.harness.log.append({
      threadId: thread,
      runId: first.harness.ids.nextRunId(),
      drafts: [{ type: 'user-said', text: 'what changed?' }],
    })
    await first.release()

    const second = await attach([{ text: 'auth and the router' }])
    const outcome = await second.harness.runner.runTurn({ threadId: thread })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(promptText(second.model, 0)).toContain('what changed?')
    const events = await second.harness.log.read({ threadId: thread })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
    await second.release()
  })

  it('carries a thinking signature written by one process into the next process prompt', async () => {
    const first = await attach([{ reasoning: { text: 'checking the diff', signature: 'sig-abc' }, text: 'two files' }])
    const thread = (await first.harness.threads.create({})).id
    await first.harness.runner.say({ threadId: thread, text: 'what changed?' })
    await first.release()

    const second = await attach([{ text: 'because the token expired' }])
    await second.harness.runner.say({ threadId: thread, text: 'why?' })

    expect(promptText(second.model, 0)).toContain('sig-abc')
    await second.release()
  })

  it('does nothing on a reopened thread whose last word was the model', async () => {
    const first = await attach([{ text: 'auth and the router' }])
    const thread = (await first.harness.threads.create({})).id
    await first.harness.runner.say({ threadId: thread, text: 'what changed?' })
    await first.release()

    const second = await attach([{ text: 'unreachable' }])
    const outcome = await second.harness.runner.runTurn({ threadId: thread })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(second.model.doStreamCalls).toHaveLength(0)
    await second.release()
  })
})
