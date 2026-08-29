import { afterEach, describe, expect, it } from 'bun:test'

import {
  ANTHROPIC_PROVIDER_ID,
  defaultPipeline,
  ECacheTtl,
  EStage,
  type Assembled,
  type BeforeStep,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { HookChain } from '../../hooks/registry'
import { createSwitchableModel } from '../../model/switchable-model'
import { scriptedModel } from '../../model/testing/scripted-model'
import { fixturePrompt } from './fixture-prompt'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

type Choice = { provider: string; modelId: string }

const ANTHROPIC: Choice = { provider: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' }
const CODEX: Choice = { provider: 'openai', modelId: 'gpt-5-codex' }

const markedParts = (assembled: Assembled): readonly unknown[] => [
  ...assembled.system.flatMap((block) => (block.providerOptions === undefined ? [] : [block.providerOptions])),
  ...assembled.messages.flatMap((entry) =>
    entry.message.content.flatMap((part) =>
      part.providerOptions === undefined ? [] : [part.providerOptions],
    ),
  ),
]

async function openSwitchable() {
  const switchable = createSwitchableModel<Choice>({
    initial: ANTHROPIC,
    keyOf: (choice) => `${choice.provider}:${choice.modelId}`,
    build: (choice) => scriptedModel({ script: [{ text: 'answered' }], ...choice }),
  })

  const seen: Assembled[] = []
  const recordAssembly: BeforeStep = async ({ assembled }) => {
    seen.push(assembled)
    return assembled
  }

  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: switchable.model,
    prompt: fixturePrompt(),
    assembly: defaultPipeline({ prompt: () => fixturePrompt(), projectDirectory: PROJECT_DIRECTORY }),
    hooks: new HookChain({
      beforeStep: [{ name: 'recordAssembly', order: { stage: EStage.Observe, nudge: 0 }, run: recordAssembly }],
    }),
  })
  opened.push({ harness, temp })

  const thread = await harness.threads.create({})

  return { harness, switchable, seen, threadId: thread.id }
}

describe('switching from Anthropic to Codex mid-session', () => {
  it('reports the newly selected provider and model, rather than the one the process launched on', async () => {
    const { harness, switchable, threadId } = await openSwitchable()

    await harness.runner.say({ threadId, text: 'what changed?' })

    expect(harness.model.identity).toEqual({ id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' })

    switchable.select(CODEX)

    expect(harness.model.identity).toEqual({ id: 'openai', modelId: 'gpt-5-codex' })
  })

  it('stops stamping Anthropic cache control once the answering model is not Anthropic', async () => {
    const { harness, switchable, seen, threadId } = await openSwitchable()

    const first = await harness.runner.say({ threadId, text: 'what changed?' })
    expect(first.status).toBe(ETurnStatus.Completed)

    const onAnthropic = seen.at(-1)
    if (onAnthropic === undefined) throw new Error('the first turn assembled nothing')
    expect(onAnthropic.system.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: ECacheTtl.OneHour } },
    })

    switchable.select(CODEX)
    const second = await harness.runner.say({ threadId, text: 'and now?' })
    expect(second.status).toBe(ETurnStatus.Completed)

    const onCodex = seen.at(-1)
    if (onCodex === undefined) throw new Error('the second turn assembled nothing')
    expect(markedParts(onCodex)).toEqual([])
  })

  it('measures the context window against the model now answering, not the launch model', async () => {
    const { harness, switchable } = await openSwitchable()

    switchable.select({ provider: ANTHROPIC_PROVIDER_ID, modelId: 'claude-haiku-4-5' })

    expect(harness.model.identity.modelId).toBe('claude-haiku-4-5')
  })
})
