import { describe, expect, it } from 'bun:test'

import {
  assemble,
  defaultPipeline,
  CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN,
  EPromptAgent,
  estimateTokens,
  PromptFragment,
  promptContextFor,
  toThreadId,
  type PromptContext,
  type PromptModel,
  type ProviderIdentity,
} from '@dltech/atlas-core'

import { InMemoryPromptRegistry } from '../../prompt/registry'

const PROJECT_DIRECTORY = '/w'

class IdentityFragment extends PromptFragment {
  readonly id = 'fixture.identity'

  text(): string {
    return 'You are Atlas.'
  }
}

class NarrowContextFragment extends PromptFragment {
  readonly id = 'fixture.narrow-context'

  override applies(ctx: PromptContext): boolean {
    return ctx.model.contextWindow <= CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN
  }

  text(): string {
    return 'Spend the window carefully; there is not much of it.'
  }
}

class CountingFragment extends PromptFragment {
  readonly id = 'fixture.counting'

  calls = 0

  text(): string {
    this.calls += 1
    return `compiled ${this.calls} time(s)`
  }
}

const ctxFor = (provider: ProviderIdentity) => ({
  events: [],
  threadId: toThreadId('thread-fixture'),
  step: 0,
  provider,
  countTokens: estimateTokens,
})

const OPUS_WINDOW: PromptModel = { contextWindow: 1_000_000 }
const HAIKU_WINDOW: PromptModel = { contextWindow: 200_000 }

const systemFor = (args: {
  registry: InMemoryPromptRegistry
  provider: ProviderIdentity
  model: PromptModel
}): readonly string[] => {
  const pipeline = defaultPipeline({
    prompt: () =>
      args.registry.compile(
        promptContextFor({
          agent: EPromptAgent.Main,
          provider: args.provider,
          model: args.model,
          projectDirectory: '/w',
        }),
      ),
    launchDirectory: PROJECT_DIRECTORY,
  })

  return assemble({ ...pipeline, ctx: ctxFor(args.provider) }).assembled.system.map((block) => block.text)
}

describe('a model switch, seen through the pipeline the composition root built once', () => {
  it('emits the fragments the newly selected model calls for, without a new pipeline', () => {
    const registry = new InMemoryPromptRegistry([new IdentityFragment(), new NarrowContextFragment()])
    let provider: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }
    let model: PromptModel = OPUS_WINDOW

    const pipeline = defaultPipeline({
      prompt: ({ projectDirectory }) =>
        registry.compile(
          promptContextFor({ agent: EPromptAgent.Main, provider, model, projectDirectory }),
        ),
      launchDirectory: PROJECT_DIRECTORY,
    })

    const onOpus = assemble({ ...pipeline, ctx: ctxFor(provider) }).assembled.system
    provider = { id: 'anthropic', modelId: 'claude-haiku-4-5' }
    model = HAIKU_WINDOW
    const onHaiku = assemble({ ...pipeline, ctx: ctxFor(provider) }).assembled.system

    expect(onOpus.map((block) => block.text)).toEqual(['You are Atlas.'])
    expect(onHaiku.map((block) => block.text)).toEqual([
      'You are Atlas.\n\nSpend the window carefully; there is not much of it.',
    ])
  })

  it('compiles once per model rather than once per assembly, so a turn is never a rebuild', () => {
    const counting = new CountingFragment()
    const registry = new InMemoryPromptRegistry([counting])
    const opus: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }
    const haiku: ProviderIdentity = { id: 'anthropic', modelId: 'claude-haiku-4-5' }

    systemFor({ registry, provider: opus, model: OPUS_WINDOW })
    systemFor({ registry, provider: opus, model: OPUS_WINDOW })
    systemFor({ registry, provider: opus, model: OPUS_WINDOW })

    expect(counting.calls).toBe(1)

    systemFor({ registry, provider: haiku, model: HAIKU_WINDOW })

    expect(counting.calls).toBe(2)
  })
})
