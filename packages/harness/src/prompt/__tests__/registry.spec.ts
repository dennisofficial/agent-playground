import { describe, expect, it } from 'bun:test'

import {
  EModelVendor,
  EPromptAgent,
  ESkipReason,
  MODEL_ID_OUTSIDE_THE_CATALOGUE,
  PromptFragment,
  deadFragmentIds,
  modelEntry,
  reachablePromptContexts,
} from '@dltech/atlas-core'

import { InMemoryPromptRegistry } from '../registry'
import { ConditionalFragment, CountingFragment, SayingFragment, contextFor } from './fake-fragments'

const forModel = (modelId: string) => contextFor({ modelId, model: modelEntry(modelId) })

const OPUS = forModel('claude-opus-5')
const CODEX = forModel('gpt-5-codex')

describe('InMemoryPromptRegistry', () => {
  it('compiles the fragments in registration order into one system block', () => {
    const registry = new InMemoryPromptRegistry([
      new SayingFragment('identity', 'first'),
      new SayingFragment('environment', 'second'),
    ])

    const compiled = registry.compile(OPUS)

    expect(compiled.parts.map((part) => part.id)).toEqual(['identity', 'environment'])
    expect(compiled.blocks).toEqual([{ text: 'first\n\nsecond' }])
  })

  it('reorders the prompt when the registration is reordered, and nothing else', () => {
    const registry = new InMemoryPromptRegistry([
      new SayingFragment('environment', 'second'),
      new SayingFragment('identity', 'first'),
    ])

    expect(registry.compile(OPUS).blocks).toEqual([{ text: 'second\n\nfirst' }])
  })

  it('measures each surviving part so a compile can be read as a budget', () => {
    const registry = new InMemoryPromptRegistry([new SayingFragment('identity', '  first  ')])

    expect(registry.compile(OPUS).parts).toEqual([{ id: 'identity', text: 'first', chars: 5 }])
  })

  it('skips a fragment whose applies is false, with Condition, and puts its text nowhere', () => {
    const registry = new InMemoryPromptRegistry([
      new SayingFragment('identity', 'kept'),
      new ConditionalFragment('thinking', 'dropped', () => false),
    ])

    const compiled = registry.compile(OPUS)

    expect(compiled.skipped).toEqual([{ id: 'thinking', reason: ESkipReason.Condition }])
    expect(compiled.blocks[0]?.text).toBe('kept')
    expect(compiled.parts.map((part) => part.id)).toEqual(['identity'])
  })

  it('skips a fragment whose text is empty or whitespace, with Empty', () => {
    const registry = new InMemoryPromptRegistry([
      new SayingFragment('nothing', ''),
      new SayingFragment('blank', '   \n  '),
      new SayingFragment('identity', 'kept'),
    ])

    const compiled = registry.compile(OPUS)

    expect(compiled.skipped).toEqual([
      { id: 'nothing', reason: ESkipReason.Empty },
      { id: 'blank', reason: ESkipReason.Empty },
    ])
    expect(compiled.blocks).toEqual([{ text: 'kept' }])
  })

  it('gives one registry two prompts when a fragment conditions on the model vendor', () => {
    const registry = new InMemoryPromptRegistry([
      new SayingFragment('identity', 'You are Atlas.'),
      new ConditionalFragment(
        'anthropic-only',
        'Anthropic-shaped advice.',
        (ctx) => ctx.model?.vendor === EModelVendor.Anthropic,
      ),
    ])

    expect(registry.compile(OPUS).blocks).toEqual([
      { text: 'You are Atlas.\n\nAnthropic-shaped advice.' },
    ])
    expect(registry.compile(CODEX).blocks).toEqual([{ text: 'You are Atlas.' }])
    expect(registry.compile(CODEX).skipped).toEqual([
      { id: 'anthropic-only', reason: ESkipReason.Condition },
    ])
  })

  it('compiles a context whose modelId is outside the catalogue without throwing', () => {
    const registry = new InMemoryPromptRegistry([
      new SayingFragment('identity', 'You are Atlas.'),
      new ConditionalFragment(
        'anthropic-only',
        'Anthropic-shaped advice.',
        (ctx) => ctx.model?.vendor === EModelVendor.Anthropic,
      ),
    ])

    const unknown = forModel('claude-opus-12')

    expect(unknown.model).toBeUndefined()
    expect(registry.compile(unknown).blocks).toEqual([{ text: 'You are Atlas.' }])
  })

  it('resolves a dated release id back to its catalogue entry', () => {
    const stamped = forModel('claude-haiku-4-5-20251001')

    expect(stamped.model?.id).toBe('claude-haiku-4-5')
  })

  it('refuses two fragments under one id at construction, naming the collision', () => {
    expect(
      () =>
        new InMemoryPromptRegistry([
          new SayingFragment('identity.atlas', 'first'),
          new SayingFragment('identity.atlas', 'second'),
        ]),
    ).toThrow(/identity\.atlas/)
  })

  it('produces no block at all when it holds no fragments', () => {
    expect(new InMemoryPromptRegistry([]).compile(OPUS)).toEqual({
      blocks: [],
      parts: [],
      skipped: [],
    })
  })

  it('produces no block when every fragment it holds is skipped', () => {
    const registry = new InMemoryPromptRegistry([
      new ConditionalFragment('gated', 'never', () => false),
      new SayingFragment('blank', ''),
    ])

    expect(registry.compile(OPUS).blocks).toEqual([])
  })
})

describe('the compile memo', () => {
  it('compiles once for an equal context, since a fragment may have read the world', () => {
    const counting = new CountingFragment('counting')
    const registry = new InMemoryPromptRegistry([counting])

    registry.compile(OPUS)
    registry.compile(forModel('claude-opus-5'))

    expect(counting.calls).toBe(1)
  })

  it('recompiles for a different modelId, which is exactly when the provider cache went cold', () => {
    const counting = new CountingFragment('counting')
    const registry = new InMemoryPromptRegistry([counting])

    registry.compile(OPUS)
    registry.compile(CODEX)

    expect(counting.calls).toBe(2)
    expect(registry.compile(CODEX).blocks).toEqual([{ text: 'compiled for gpt-5-codex' }])
  })

  it('recompiles for a different provider under the same modelId', () => {
    const counting = new CountingFragment('counting')
    const registry = new InMemoryPromptRegistry([counting])

    registry.compile(contextFor({ modelId: 'claude-opus-5', providerId: 'anthropic-oauth' }))
    registry.compile(contextFor({ modelId: 'claude-opus-5', providerId: 'bedrock' }))

    expect(counting.calls).toBe(2)
  })

  it('keys on the provider modelId rather than the resolved entry, so two ids for one entry differ', () => {
    const counting = new CountingFragment('counting')
    const registry = new InMemoryPromptRegistry([counting])

    registry.compile(forModel('claude-haiku-4-5'))
    registry.compile(forModel('claude-haiku-4-5-20251001'))

    expect(counting.calls).toBe(2)
  })
})

describe('dead prose', () => {
  const contexts = reachablePromptContexts({
    agents: Object.values(EPromptAgent),
    providerIds: ['anthropic-oauth'],
  })

  const idsThatAreDead = (fragments: readonly PromptFragment[]): readonly string[] =>
    deadFragmentIds({ fragments, contexts })

  it('names a fragment no reachable context can ever select', () => {
    const fragments = [
      new SayingFragment('identity', 'always'),
      new ConditionalFragment('never', 'unreachable', () => false),
    ]

    expect(idsThatAreDead(fragments)).toEqual(['never'])
  })

  it('leaves a fragment alive when one catalogue entry selects it', () => {
    const fragments = [
      new ConditionalFragment('openai-only', 'text', (ctx) => ctx.model?.vendor === EModelVendor.OpenAI),
    ]

    expect(idsThatAreDead(fragments)).toEqual([])
  })

  it('leaves a fragment alive when only the uncatalogued-model context selects it', () => {
    const fragments = [
      new ConditionalFragment('unknown-only', 'text', (ctx) => ctx.model === undefined),
    ]

    expect(contexts.some((ctx) => ctx.provider.modelId === MODEL_ID_OUTSIDE_THE_CATALOGUE)).toBe(true)
    expect(idsThatAreDead(fragments)).toEqual([])
  })
})
