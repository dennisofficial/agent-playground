import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  EToolEffect,
  RESUME_NUDGE,
  type ChunkType,
  type Event,
  type ThreadId,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { fixturePrompt } from './fixture-prompt'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

const readDeclaration: ToolDeclaration = {
  name: 'read_file',
  description: 'read a file',
  effect: EToolEffect.Read,
  inputSchema: z.object({ path: z.string() }),
}

type CutShort = {
  harness: AtlasHarness
  model: MockLanguageModelV4
  threadId: ThreadId
  interruption: AbortSignal
}

async function openCutShortAt(args: {
  script: readonly ScriptedStep[]
  chunk: ChunkType
  tools?: readonly ToolDeclaration[] | undefined
}): Promise<CutShort> {
  const temp = createTempDatabase()
  const controller = new AbortController()
  const model = scriptedModel({ script: args.script })
  let armed = true

  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model,
    prompt: fixturePrompt(),
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
  return { harness, model, threadId: thread.id, interruption: controller.signal }
}

const typesOf = (events: readonly Event[]): string[] => events.map((event) => event.type)

const promptText = (model: MockLanguageModelV4, call: number): string =>
  JSON.stringify(model.doStreamCalls[call]?.prompt ?? [])

describe('resuming a turn the developer stopped', () => {
  it('nudges past a reply that was the last word, so the loop has somewhere to go', async () => {
    const cut = await openCutShortAt({
      script: [{ text: 'the router changed because' }, { text: ' the token expired' }],
      chunk: 'text-delta',
    })

    const stopped = await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what changed?',
      signal: cut.interruption,
    })
    expect(stopped.status).toBe(ETurnStatus.Interrupted)

    const resumed = await cut.harness.runner.resume({ threadId: cut.threadId })

    expect(resumed.status).toBe(ETurnStatus.Completed)
    expect(typesOf(await cut.harness.log.read({ threadId: cut.threadId }))).toEqual([
      'user-said',
      'assistant-said',
      'nudge',
      'assistant-said',
    ])
  })

  it('shows the model what it had already said, and the nudge after it', async () => {
    const cut = await openCutShortAt({
      script: [{ text: 'the router changed because' }, { text: ' the token expired' }],
      chunk: 'text-delta',
    })

    await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what changed?',
      signal: cut.interruption,
    })
    await cut.harness.runner.resume({ threadId: cut.threadId })

    const resumedPrompt = promptText(cut.model, 1)
    expect(resumedPrompt).toContain('the router changed because')
    expect(resumedPrompt).toContain(RESUME_NUDGE)
  })

  it('drops the nudge from the prompt once the model has answered it', async () => {
    const cut = await openCutShortAt({
      script: [
        { text: 'the router changed because' },
        { text: ' the token expired', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] },
        { text: 'and that is all' },
      ],
      chunk: 'text-delta',
      tools: [readDeclaration],
    })

    await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what changed?',
      signal: cut.interruption,
    })
    await cut.harness.runner.resume({ threadId: cut.threadId })

    expect(promptText(cut.model, 1)).toContain(RESUME_NUDGE)
    expect(promptText(cut.model, 2)).not.toContain(RESUME_NUDGE)
  })

  it('appends nothing when a tool settlement already gives the loop its next move', async () => {
    const cut = await openCutShortAt({
      script: [
        { text: 'reading', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] },
        { text: 'it exports nothing' },
      ],
      chunk: 'tool-call',
      tools: [readDeclaration],
    })

    await cut.harness.runner.say({
      threadId: cut.threadId,
      text: 'what is in a.ts?',
      signal: cut.interruption,
    })

    const resumed = await cut.harness.runner.resume({ threadId: cut.threadId })

    expect(resumed.status).toBe(ETurnStatus.Completed)
    expect(typesOf(await cut.harness.log.read({ threadId: cut.threadId }))).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-denied',
      'assistant-said',
    ])
  })

  it('goes idle rather than re-asking when the model finished of its own accord', async () => {
    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({ script: [{ text: 'done' }] }),
      prompt: fixturePrompt(),
    })
    opened.push({ harness, temp })

    const thread = await harness.threads.create({})
    await harness.runner.say({ threadId: thread.id, text: 'anything?' })

    const resumed = await harness.runner.resume({ threadId: thread.id })

    expect(resumed.status).toBe(ETurnStatus.Idle)
    expect(typesOf(await harness.log.read({ threadId: thread.id }))).toEqual([
      'user-said',
      'assistant-said',
    ])
  })
})
