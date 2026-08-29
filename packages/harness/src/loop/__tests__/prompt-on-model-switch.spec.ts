import { describe, expect, it } from 'bun:test'

import {
  assemble,
  defaultPipeline,
  EPromptAgent,
  EThinkingControl,
  estimateTokens,
  PromptFragment,
  promptContextFor,
  toThreadId,
  type PromptContext,
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

class BudgetThinkingFragment extends PromptFragment {
  readonly id = 'fixture.thinking-budget'

  override applies(ctx: PromptContext): boolean {
    return ctx.model?.thinkingControl === EThinkingControl.Budget
  }

  text(): string {
    return 'Ask for thinking with a token budget.'
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

const systemFor = (args: {
  registry: InMemoryPromptRegistry
  provider: ProviderIdentity
}): readonly string[] => {
  const pipeline = defaultPipeline({
    prompt: () =>
      args.registry.compile(promptContextFor({ agent: EPromptAgent.Main, provider: args.provider })),
    projectDirectory: PROJECT_DIRECTORY,
  })

  return assemble({ ...pipeline, ctx: ctxFor(args.provider) }).assembled.system.map((block) => block.text)
}

describe('a model switch, seen through the pipeline the composition root built once', () => {
  it('emits the fragments the newly selected model calls for, without a new pipeline', () => {
    const registry = new InMemoryPromptRegistry([new IdentityFragment(), new BudgetThinkingFragment()])
    let provider: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }

    const pipeline = defaultPipeline({
      prompt: () => registry.compile(promptContextFor({ agent: EPromptAgent.Main, provider })),
      projectDirectory: PROJECT_DIRECTORY,
    })

    const onOpus = assemble({ ...pipeline, ctx: ctxFor(provider) }).assembled.system
    provider = { id: 'anthropic', modelId: 'claude-haiku-4-5' }
    const onHaiku = assemble({ ...pipeline, ctx: ctxFor(provider) }).assembled.system

    expect(onOpus.map((block) => block.text)).toEqual(['You are Atlas.'])
    expect(onHaiku.map((block) => block.text)).toEqual([
      'You are Atlas.\n\nAsk for thinking with a token budget.',
    ])
  })

  it('compiles once per model rather than once per assembly, so a turn is never a rebuild', () => {
    const counting = new CountingFragment()
    const registry = new InMemoryPromptRegistry([counting])
    const opus: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }
    const haiku: ProviderIdentity = { id: 'anthropic', modelId: 'claude-haiku-4-5' }

    systemFor({ registry, provider: opus })
    systemFor({ registry, provider: opus })
    systemFor({ registry, provider: opus })

    expect(counting.calls).toBe(1)

    systemFor({ registry, provider: haiku })

    expect(counting.calls).toBe(2)
  })

  it('resolves the model entry from the id the provider reports, so the two cannot disagree', () => {
    const ctx = promptContextFor({
      agent: EPromptAgent.Main,
      provider: { id: 'anthropic', modelId: 'claude-haiku-4-5' },
    })

    expect(ctx.model?.thinkingControl).toBe(EThinkingControl.Budget)
  })

  it('leaves the model undefined for an id outside the catalogue, rather than guessing', () => {
    const ctx = promptContextFor({
      agent: EPromptAgent.Main,
      provider: { id: 'gateway', modelId: 'some-model-nobody-catalogued' },
    })

    expect(ctx.model).toBeUndefined()
  })
})
