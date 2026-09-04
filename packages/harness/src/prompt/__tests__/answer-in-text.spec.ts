import { describe, expect, it } from 'bun:test'

import { EPromptAgent, PromptFragment, type PromptContext } from '@dltech/atlas-core'

import {
  createIsolatedContainer,
  portToken,
  resolveSet,
  type DependencyContainer,
} from '../../container/injection'
import { SkillRegistryPort } from '../../skills/port'
import { AnswerInTextFragment } from '../fragments/models'
import { registerBuiltinPromptFragments } from '../register-prompt-fragments'
import { PromptRegistry } from '../registry'
import { FakeSkillRegistry } from './fake-skills'

const contextFor = ({
  agent = EPromptAgent.Main,
  providerId,
  modelId,
}: {
  agent?: EPromptAgent
  providerId: string
  modelId: string
}): PromptContext => ({
  agent,
  provider: { id: providerId, modelId },
  model: { contextWindow: 200_000 },
  projectDirectory: '/w',
})

const registered = (): DependencyContainer => {
  const container = createIsolatedContainer()
  registerBuiltinPromptFragments({ container })
  container.register(portToken(SkillRegistryPort), {
    useValue: new FakeSkillRegistry({ skills: [] }),
  })
  return container
}

const compiledFor = (ctx: PromptContext): readonly string[] =>
  registered()
    .resolve(portToken(PromptRegistry))
    .compile(ctx)
    .parts.map((part) => part.id)

describe('the answer-in-text fragment across the model axis', () => {
  const fragment = new AnswerInTextFragment()

  it('applies to the kimi fast model whose answer vanished into reasoning', () => {
    expect(
      fragment.applies(contextFor({ providerId: 'inference', modelId: 'kimi-k3-fast' })),
    ).toBe(true)
  })

  it("applies to kimi reached through another provider, since the quirk is the model's", () => {
    expect(
      fragment.applies(contextFor({ providerId: 'openrouter', modelId: 'moonshotai/kimi-k3' })),
    ).toBe(true)
  })

  it('stays out of prompts for models without the quirk', () => {
    expect(
      fragment.applies(contextFor({ providerId: 'anthropic-oauth', modelId: 'claude-opus-5' })),
    ).toBe(false)
  })

  it('applies to a sub-agent on kimi, whose answer is equally invisible', () => {
    expect(
      fragment.applies(
        contextFor({ agent: EPromptAgent.Sub, providerId: 'inference', modelId: 'kimi-k3-fast' }),
      ),
    ).toBe(true)
  })
})

describe('what the fragment tells the model', () => {
  it('pins the prose', () => {
    expect(new AnswerInTextFragment().text()).toBe(
      [
        'Finish every turn in the text channel, never in reasoning alone. The developer sees only your',
        'text; a reply that lives entirely in reasoning renders as nothing, ends the turn, and leaves a',
        'summariser to answer in your place. When the work is done, write the full answer as message text.',
      ].join('\n'),
    )
  })
})

describe('the fragment in the compiled prompt', () => {
  it('appears when a kimi model is answering', () => {
    expect(compiledFor(contextFor({ providerId: 'inference', modelId: 'kimi-k3-fast' }))).toContain(
      'models.answer-in-text',
    )
  })

  it('is absent when any other model is answering', () => {
    expect(
      compiledFor(contextFor({ providerId: 'anthropic-oauth', modelId: 'claude-opus-5' })),
    ).not.toContain('models.answer-in-text')
  })

  it('is registered with the builtins, so no wiring stands between it and the prompt', () => {
    const fragments = resolveSet({
      container: registered(),
      token: portToken(PromptFragment),
    })

    expect(fragments.map((fragment) => fragment.id)).toContain('models.answer-in-text')
  })
})
