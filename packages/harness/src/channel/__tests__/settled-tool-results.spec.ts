import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { defaultPipeline, EMPTY_PROMPT, EToolEffect, type Event, type ToolDefinition } from '@dltech/atlas-core'

import { createDeltaChannel, PublishingTurnRunner, type DeltaChannel } from '..'
import { buildHarness, ETurnStatus, type AtlasHarness } from '../../loop'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { scriptedModel } from '../../model/testing/scripted-model'
import { HookChain } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

const readTool: ToolDefinition = {
  name: 'read',
  description: 'read a file',
  effect: EToolEffect.Read,
  inputSchema: z.object({ path: z.string() }),
  invoke: async () => ({ ok: true, output: 'const a = 1', modelText: '1\tconst a = 1' }),
}

function announcing(inner: DeltaChannel): { channel: DeltaChannel; announced: Event[] } {
  const announced: Event[] = []

  return {
    announced,
    channel: {
      subscribe: (args) => inner.subscribe(args),
      snapshot: (args) => inner.snapshot(args),
      publisherFor: (args) => {
        const publisher = inner.publisherFor(args)
        return {
          threadId: publisher.threadId,
          onChunk: publisher.onChunk,
          toolOutput: (outputArgs) => publisher.toolOutput(outputArgs),
          settleAppend: ({ events }) => {
            announced.push(...events)
            publisher.settleAppend({ events })
          },
          close: (closeArgs) => publisher.close(closeArgs),
          retrying: (notice) => publisher.retrying(notice),
        }
      },
    },
  }
}

describe('a turn that settles a tool call', () => {
  it('settles through the one log the loop writes through, not a second log of its own', async () => {
    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({
        script: [
          { text: 'reading', calls: [{ callId: 'call-1', name: 'read', input: { path: 'a.ts' } }] },
          { text: 'one line' },
        ],
      }),
    })
    opened.push({ harness, temp })

    const registry = new InMemoryToolRegistry([readTool])
    const { channel, announced } = announcing(createDeltaChannel())
    const runner = new PublishingTurnRunner({
      channel,
      deps: {
        log: harness.log,
        model: harness.model,
        ids: harness.ids,
        assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
        tools: () => registry.declarations(),
        dispatch: new HookedToolDispatcher({ approvals: EApprovalRouting.Operator, registry, hooks: new HookChain({}) }),
      },
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'read a.ts' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(announced.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
  })
})
