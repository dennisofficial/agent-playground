import { afterEach, describe, expect, it } from 'bun:test'

import { defaultPipeline, EMPTY_PROMPT, type ThreadId } from '@dltech/atlas-core'

import { createDeltaChannel } from '../../../channel/delta-channel'
import type { ChannelSignal } from '../../../channel/signal'
import { HookChain } from '../../../hooks/registry'
import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase, type TempDatabase } from '../../../loop/__tests__/temp-database'
import { scriptedModel } from '../../../model/testing/scripted-model'
import { InMemoryToolRegistry } from '../../../tools/registry'
import { buildChildRunner } from '../child-runner'
import { agentTypeNamed } from './fixtures'

const PROJECT_DIRECTORY = '/w'

const CHILD_PROSE = 'the child answered'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

async function childTurnWatched(): Promise<{
  child: readonly ChannelSignal[]
  parent: readonly ChannelSignal[]
}> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: [{ text: CHILD_PROSE }] })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })

  const assembly = defaultPipeline({
    prompt: () => EMPTY_PROMPT,
    launchDirectory: PROJECT_DIRECTORY,
  })
  const channel = createDeltaChannel()

  const parentId = (await harness.threads.create({})).id
  const threadId = (await harness.threads.create({})).id
  await harness.log.append({
    threadId,
    runId: harness.ids.nextRunId(),
    drafts: [{ type: 'user-said', text: 'count the call sites of assemble' }],
  })

  const child: ChannelSignal[] = []
  const parent: ChannelSignal[] = []
  const watch = (threadId: ThreadId, into: ChannelSignal[]) =>
    channel.subscribe({ threadId, listener: (signal) => void into.push(signal) })

  const forgetChild = watch(threadId, child)
  const forgetParent = watch(parentId, parent)

  const runner = buildChildRunner({
    agentType: agentTypeNamed({ name: 'explore' }),
    threadId,
    observe: () => undefined,
    observeContext: () => undefined,
    steering: () => [],
    deps: {
      turn: {
        log: harness.log,
        model: harness.model,
        ids: harness.ids,
        assembly,
        launchDirectory: PROJECT_DIRECTORY,
      },
      tools: new InMemoryToolRegistry([]),
      hooks: new HookChain({}),
      channel,
      drainNotices: async () => [],
      assemblyFor: () => assembly,
    },
  })

  await runner.runTurn({ threadId })
  forgetChild()
  forgetParent()

  return { child, parent }
}

describe("a sub-agent's turn on the delta channel", () => {
  it('streams its chunks under its own thread id, so a reader of the child sees it work', async () => {
    const { child } = await childTurnWatched()

    const chunks = child.filter((signal) => signal.type === 'chunk')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('opens and closes a step, which is what a working indicator reads', async () => {
    const { child } = await childTurnWatched()
    const kinds = child.map((signal) => signal.type)

    expect(kinds).toContain('step-started')
    expect(kinds).toContain('step-ended')
  })

  it('says nothing at all on the thread that spawned it', async () => {
    const { parent } = await childTurnWatched()

    expect(parent).toEqual([])
  })
})
