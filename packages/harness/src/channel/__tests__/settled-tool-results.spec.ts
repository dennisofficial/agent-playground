import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { defaultRules, EToolEffect, type Event, type ToolDefinition } from '@dltech/atlas-core'

import { createDeltaChannel, createPublishingTurnRunner, type DeltaChannel } from '..'
import { buildHarness, ETurnStatus, type AtlasHarness } from '../../loop'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { scriptedModel } from '../../model/testing/scripted-model'
import { createHookRegistry } from '../../hooks/registry'
import { createDispatch } from '../../tools/dispatch'
import { createToolRegistry } from '../../tools/registry'

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
          branchId: publisher.branchId,
          onChunk: publisher.onChunk,
          settleAppend: ({ events }) => {
            announced.push(...events)
            publisher.settleAppend({ events })
          },
          close: (closeArgs) => publisher.close(closeArgs),
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

    const registry = createToolRegistry([readTool])
    const { channel, announced } = announcing(createDeltaChannel())
    const runner = createPublishingTurnRunner({
      channel,
      deps: {
        log: harness.log,
        model: harness.model,
        ids: harness.ids,
        rules: defaultRules(),
        tools: registry.declarations(),
        dispatch: createDispatch({ registry, hooks: createHookRegistry({}) }),
      },
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'read a.ts' })

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
