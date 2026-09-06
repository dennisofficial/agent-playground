import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  defaultPipeline,
  EBeforeToolDecision,
  EMPTY_PROMPT,
  EStage,
  EToolEffect,
  type BeforeTool,
  type ThreadId,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { createDeltaChannel } from '../../../channel/delta-channel'
import { HookChain, type RegisteredHook } from '../../../hooks/registry'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { buildChildRunner } from '../child-runner'
import { agentTypeNamed } from './fixtures'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

const asking: RegisteredHook<BeforeTool> = {
  name: 'asker',
  order: { stage: EStage.Policy, nudge: 0 },
  run: async () => ({
    decision: EBeforeToolDecision.Ask,
    reason: 'this discards work in a worktree that is not ours.',
  }),
}

const readTool: ToolDefinition = {
  name: 'read',
  description: 'the read tool',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: {}, modelText: 'read ran' }),
}

async function childAsked(): Promise<{ harness: AtlasHarness; threadId: ThreadId }> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({
      script: [
        { calls: [{ callId: 'call_read', name: 'read', input: {} }] },
        { text: 'I could not read it' },
      ],
    }),
  })
  opened.push({ harness, temp })

  const threadId = (await harness.threads.create({})).id
  const assembly = defaultPipeline({
    prompt: () => EMPTY_PROMPT,
    launchDirectory: PROJECT_DIRECTORY,
  })

  const runner = buildChildRunner({
    agentType: agentTypeNamed({ name: 'explore' }),
    threadId,
    projectDirectory: undefined,
    observe: () => {},
    observeContext: () => {},
    steering: () => [],
    deps: {
      turn: {
        log: harness.log,
        model: harness.model,
        ids: harness.ids,
        assembly,
        launchDirectory: PROJECT_DIRECTORY,
      },
      tools: new InMemoryToolRegistry([readTool]),
      hooks: new HookChain({ beforeTool: [asking] }),
      channel: createDeltaChannel(),
      assemblyFor: () => assembly,
      drainNotices: async () => [],
    },
  })

  await runner.say({ threadId, text: 'read the file' })
  return { harness, threadId }
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe('a sub-agent whose call a hook wants a human to answer', () => {
  it('is denied rather than paused, because no human is attached to its thread', async () => {
    const { harness, threadId } = await childAsked()
    const events = await harness.log.read({ threadId })

    expect(events.map((event) => event.type)).toContain('tool-denied')
    expect(events.map((event) => event.type)).not.toContain('approval-requested')
  })

  it('is told why, so it can report back rather than retry blindly', async () => {
    const { harness, threadId } = await childAsked()
    const denied = (await harness.log.read({ threadId })).find(
      (event) => event.type === 'tool-denied',
    )

    expect(denied?.type === 'tool-denied' ? denied.reason : '').toContain('No operator is attached')
  })
})
