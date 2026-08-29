import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  EToolEffect,
  pendingCalls,
  toCallId,
  type ThreadId,
  type ChunkType,
  type Event,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { interruptibleModel } from '../../model/testing/interruptible-model'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { fixturePrompt } from './fixture-prompt'
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
  threadId: ThreadId
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
    prompt: fixturePrompt(),
    onChunk: (chunk) => {
      if (armed && chunk.type === 'text-delta') {
        armed = false
        controller.abort()
      }
      return chunk
    },
  })

  opened.push({ harness, temp })
  const thread = await harness.threads.create({})
  return { harness, model, threadId: thread.id, interruption: controller.signal }
}

async function openWith(script: readonly ScriptedStep[]): Promise<{ harness: AtlasHarness; threadId: ThreadId }> {
  const temp = createTempDatabase()
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model: scriptedModel({ script }) })
  opened.push({ harness, temp })
  const thread = await harness.threads.create({})
  return { harness, threadId: thread.id }
}

const readDeclaration: ToolDeclaration = {
  name: 'read_file',
  description: 'read a file',
  effect: EToolEffect.Read,
  inputSchema: z.object({ path: z.string() }),
}

async function openCutShortAt(args: {
  script: readonly ScriptedStep[]
  chunk: ChunkType
  tools?: readonly ToolDeclaration[] | undefined
}): Promise<{ harness: AtlasHarness; threadId: ThreadId; interruption: AbortSignal }> {
  const temp = createTempDatabase()
  const controller = new AbortController()
  let armed = true

  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: args.script }),
    ...(args.tools === undefined ? {} : { tools: args.tools }),
    onChunk: (chunk) => {
      if (armed && chunk.type === args.chunk) {
        armed = false
        controller.abort()
      }
      return chunk
    },
  })

  opened.push({ harness, temp })
  const thread = await harness.threads.create({})
  return { harness, threadId: thread.id, interruption: controller.signal }
}

const assistantTurns = (events: readonly Event[]) => events.filter((event) => event.type === 'assistant-said')

describe('interrupting a step that had already asked for a tool', () => {
  it('records the call it emitted and settles it as something that never ran', async () => {
    const cut = await openCutShortAt({
      script: [{ text: 'reading', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] }],
      chunk: 'tool-call',
      tools: [readDeclaration],
    })

    const outcome = await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what is in a.ts?',
      signal: cut.interruption,
    })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    const events = await cut.harness.log.read({ threadId: cut.threadId })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-denied',
    ])

    const denial = events.find((event) => event.type === 'tool-denied')
    expect(denial?.type === 'tool-denied' ? denial.callId : '').toBe(toCallId('call-1'))
    expect(denial?.type === 'tool-denied' ? denial.reason : '').toMatch(/interrupted/)
  })

  it('reports the exchange committed, because the model asked for work the log now holds', async () => {
    const cut = await openCutShortAt({
      script: [{ text: 'reading', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] }],
      chunk: 'tool-call',
      tools: [readDeclaration],
    })

    const outcome = await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what is in a.ts?',
      signal: cut.interruption,
    })

    expect(outcome.status === ETurnStatus.Interrupted ? outcome.committed : undefined).toBe(true)
  })

  it('leaves nothing pending, so no later turn tries to run what the developer stopped', async () => {
    const cut = await openCutShortAt({
      script: [{ text: 'reading', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] }],
      chunk: 'tool-call',
      tools: [readDeclaration],
    })

    await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what is in a.ts?',
      signal: cut.interruption,
    })

    const events = await cut.harness.log.read({ threadId: cut.threadId })
    expect(pendingCalls(events)).toEqual([])
  })
})

describe('interrupting a streaming reply', () => {
  it('keeps what had already streamed as one assistant turn marked interrupted', async () => {
    const armed = await openArmed()

    const outcome = await armed.harness.runner.say({
      threadId: armed.threadId,
      text: 'what changed?',
      signal: armed.interruption,
    })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    const events = await armed.harness.log.read({ threadId: armed.threadId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])

    const [reply] = assistantTurns(events)
    if (reply?.type !== 'assistant-said') throw new Error('the thread holds no assistant turn')
    expect(reply.parts).toEqual([{ type: 'text', text: HEAD }])
    expect(reply.interrupted).toBe(true)
  })

  it('reports the exchange committed, because prose the developer read is not discardable', async () => {
    const armed = await openArmed()

    const outcome = await armed.harness.runner.say({
      threadId: armed.threadId,
      text: 'what changed?',
      signal: armed.interruption,
    })

    expect(outcome.status === ETurnStatus.Interrupted ? outcome.committed : undefined).toBe(true)
  })

  it('reports nothing committed when the step got no further than thinking', async () => {
    const cut = await openCutShortAt({
      script: [{ reasoning: { text: 'weighing it up' } }],
      chunk: 'reasoning-delta',
    })

    const outcome = await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what changed?',
      signal: cut.interruption,
    })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    expect(outcome.status === ETurnStatus.Interrupted ? outcome.committed : undefined).toBe(false)
    const events = await cut.harness.log.read({ threadId: cut.threadId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
    const [thought] = assistantTurns(events)
    expect(thought?.type === 'assistant-said' ? thought.parts.map((part) => part.type) : []).toEqual(['reasoning'])
  })

  it('appends nothing when the abort landed before any text arrived', async () => {
    const { harness, threadId } = await openWith([{ text: 'unreachable' }])
    const controller = new AbortController()
    controller.abort()

    const outcome = await harness.runner.say({ threadId, text: 'what changed?', signal: controller.signal })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    expect(outcome.status === ETurnStatus.Interrupted ? outcome.committed : undefined).toBe(false)
    const events = await harness.log.read({ threadId })
    expect(events.map((event) => event.type)).toEqual(['user-said'])
  })

  it('waits for input on the next turn rather than re-asking', async () => {
    const armed = await openArmed()
    await armed.harness.runner.say({ threadId: armed.threadId, text: 'what changed?', signal: armed.interruption })
    const asked = armed.model.doStreamCalls.length

    const outcome = await armed.harness.runner.runTurn({ threadId: armed.threadId })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(armed.model.doStreamCalls).toHaveLength(asked)
    const events = await armed.harness.log.read({ threadId: armed.threadId })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })

  it('renders the interrupted turn back to the model unchanged', async () => {
    const armed = await openArmed()
    await armed.harness.runner.say({ threadId: armed.threadId, text: 'what changed?', signal: armed.interruption })

    const outcome = await armed.harness.runner.say({ threadId: armed.threadId, text: 'go on' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    const prompt = armed.model.doStreamCalls[1]?.prompt ?? []
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])

    const replayed = prompt[2]
    if (replayed?.role !== 'assistant') throw new Error('the prompt replayed no assistant turn')
    expect(replayed.content).toEqual([{ type: 'text', text: HEAD }])
  })
})
