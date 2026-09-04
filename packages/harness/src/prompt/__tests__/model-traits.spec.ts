import { describe, expect, it } from 'bun:test'

import {
  CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN,
  EImageTier,
  EPromptAgent,
  PROMPT_MODEL_SAMPLES,
  PromptFragment,
  deadFragmentIds,
  promptModelExtremes,
  promptModelOf,
  reachablePromptContexts,
  unreadModelTraits,
  type ModelCard,
  type ModelTraitProbe,
  type PromptContext,
} from '@dltech/atlas-core'

import {
  createIsolatedContainer,
  portToken,
  resolveSet,
  type DependencyContainer,
} from '../../container/injection'
import { SkillRegistryPort } from '../../skills/port'
import { registerBuiltinPromptFragments } from '../register-prompt-fragments'
import { FakeSkillRegistry, fakeSkill } from './fake-skills'

const cardWithWindow = (contextWindow: number): ModelCard => ({
  ref: { providerId: 'fixture', modelId: 'a-model' },
  label: 'a model',
  api: 'fixture',
  contextWindow,
  imageTier: EImageTier.Standard,
})

const LONG_DESCRIPTION = 'covers one narrow kind of work and says exactly when it applies. '.repeat(
  20,
)

const CROWDED_SKILL_SHELF = Array.from({ length: 60 }, (_, at) =>
  fakeSkill({ name: `skill-${at}`, description: `${at} ${LONG_DESCRIPTION}` }),
)

const registered = (): DependencyContainer => {
  const container = createIsolatedContainer()
  registerBuiltinPromptFragments({ container })
  container.register(portToken(SkillRegistryPort), {
    useValue: new FakeSkillRegistry({ skills: CROWDED_SKILL_SHELF }),
  })
  return container
}

const builtinFragments = (): readonly PromptFragment[] =>
  resolveSet({ container: registered(), token: portToken(PromptFragment) })

const baseContext = (): PromptContext => ({
  agent: EPromptAgent.Main,
  provider: { id: 'anthropic-oauth', modelId: 'claude-opus-5' },
  model: { contextWindow: 1_000_000 },
  projectDirectory: '/w',
})

describe('the model traits carried into a prompt', () => {
  it('resolves a card to the window the card gives it', () => {
    expect(promptModelOf(cardWithWindow(200_000)).contextWindow).toBe(200_000)
  })

  it('resolves a model no catalogue holds rather than leaving a hole for each fragment to fill', () => {
    expect(promptModelOf(undefined)).toEqual({
      contextWindow: CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN,
    })
  })
})

describe('the sampled traits the coverage test fans over', () => {
  it('samples each distinct window once, ascending, rather than each model', () => {
    const windows = PROMPT_MODEL_SAMPLES.map((model) => model.contextWindow)

    expect(windows).toEqual([...windows].sort((left, right) => left - right))
    expect(new Set(windows).size).toBe(windows.length)
  })

  it('includes the window an unknown model resolves to, which is the common case at scale', () => {
    expect(PROMPT_MODEL_SAMPLES).toContainEqual({
      contextWindow: CONTEXT_WINDOW_WHEN_THE_MODEL_IS_UNKNOWN,
    })
  })

  it('stays bounded by the shape of a trait rather than by how many models exist', () => {
    const contexts = reachablePromptContexts({
      agents: Object.values(EPromptAgent),
      providerIds: ['anthropic-oauth'],
      projectDirectory: '/w',
    })

    expect(contexts.length).toBe(Object.values(EPromptAgent).length * PROMPT_MODEL_SAMPLES.length)
  })
})

describe('no builtin fragment is prose no reachable context can select', () => {
  it('holds nothing dead across every sampled trait and agent', () => {
    expect(
      deadFragmentIds({
        fragments: builtinFragments(),
        contexts: [
          ...reachablePromptContexts({
            agents: Object.values(EPromptAgent),
            providerIds: ['anthropic-oauth'],
            projectDirectory: '/w',
          }),
          {
            agent: EPromptAgent.Main,
            provider: { id: 'inference', modelId: 'kimi-k3-fast' },
            model: { contextWindow: 200_000 },
            projectDirectory: '/w',
          },
        ],
      }),
    ).toEqual([])
  })
})

describe('no trait is carried that no fragment reads', () => {
  const probesFor = (base: PromptContext): readonly ModelTraitProbe[] => {
    const { narrowest, widest } = promptModelExtremes()
    const other =
      base.model.contextWindow === widest.contextWindow ? narrowest : widest

    return [{ key: 'contextWindow', model: other }]
  }

  it('changes what the model is told when a trait it reads moves', () => {
    const base = baseContext()

    expect(
      unreadModelTraits({ fragments: builtinFragments(), base, probes: probesFor(base) }),
    ).toEqual([])
  })

  it('names a trait nothing reads, so a field cannot be added and quietly forgotten', () => {
    const base = baseContext()
    const unreadProbe: ModelTraitProbe = { key: 'invented', model: base.model }

    expect(
      unreadModelTraits({ fragments: builtinFragments(), base, probes: [unreadProbe] }),
    ).toEqual(['invented'])
  })
})
