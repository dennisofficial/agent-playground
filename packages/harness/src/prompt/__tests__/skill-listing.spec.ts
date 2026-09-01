import { describe, expect, it } from 'bun:test'

import { EPromptAgent, ESkipReason, modelEntry, type PromptContext } from '@dltech/atlas-core'

import { SkillListingFragment } from '../fragments/skills'
import { InMemoryPromptRegistry } from '../registry'
import { SayingFragment } from './fake-fragments'
import { FakeSkillRegistry, fakeSkill } from './fake-skills'

const OPUS: PromptContext = {
  agent: EPromptAgent.Main,
  provider: { id: 'anthropic-oauth', modelId: 'claude-opus-5' },
  model: modelEntry('claude-opus-5'), projectDirectory: '/w'
}

const CORPUS = [
  fakeSkill({ name: 'research', description: 'Investigate a question against primary sources' }),
  fakeSkill({
    name: 'grilling',
    description: 'Stress-test a plan',
    whenToUse: 'before committing',
  }),
  fakeSkill({ name: 'daily-update', description: 'Post the standup', modelInvocable: false }),
]

const fragmentOver = (registry: FakeSkillRegistry): SkillListingFragment =>
  new SkillListingFragment(registry)

const listingOver = (registry: FakeSkillRegistry): string => fragmentOver(registry).text(OPUS)

describe('the skill listing fragment', () => {
  it('lists a skill the model may invoke', () => {
    const text = listingOver(new FakeSkillRegistry({ skills: CORPUS }))

    expect(text).toContain('research')
    expect(text).toContain('grilling')
  })

  it('leaves out a skill that sets disable-model-invocation', () => {
    const text = listingOver(new FakeSkillRegistry({ skills: CORPUS }))

    expect(text).not.toContain('daily-update')
  })

  it('carries each summary, so the model can choose without loading anything', () => {
    const text = listingOver(new FakeSkillRegistry({ skills: CORPUS }))

    expect(text).toContain('Investigate a question against primary sources')
  })

  it('carries none of the skill bodies, which are the tool call', () => {
    const text = listingOver(new FakeSkillRegistry({ skills: CORPUS }))

    expect(text).not.toContain('Run the research procedure.')
  })

  it('tells the model to reach for the skill tool by name', () => {
    const text = listingOver(new FakeSkillRegistry({ skills: CORPUS }))

    expect(text).toContain('skill tool')
  })

  it('emits nothing when no skill is model-invocable', () => {
    const text = listingOver(
      new FakeSkillRegistry({ skills: [fakeSkill({ name: 'private', modelInvocable: false })] }),
    )

    expect(text).toBe('')
  })

  it('emits nothing when no skill was discovered at all', () => {
    expect(listingOver(new FakeSkillRegistry({ skills: [] }))).toBe('')
  })

  it('applies to every agent the prompt is compiled for', () => {
    const fragment = fragmentOver(new FakeSkillRegistry({ skills: CORPUS }))

    for (const agent of Object.values(EPromptAgent)) {
      expect(fragment.applies({ ...OPUS, agent })).toBe(true)
    }
  })
})

describe('the listing compiled into a prompt', () => {
  const registryHolding = (skills: FakeSkillRegistry): InMemoryPromptRegistry =>
    new InMemoryPromptRegistry([
      new SayingFragment('identity', 'You are Atlas.'),
      fragmentOver(skills),
    ])

  it('sits alongside the rest of the preamble in one block', () => {
    const compiled = registryHolding(new FakeSkillRegistry({ skills: CORPUS })).compile(OPUS)

    expect(compiled.parts.map((part) => part.id)).toEqual(['identity', 'skills.listing'])
  })

  it('is skipped as empty when there is nothing to list', () => {
    const compiled = registryHolding(new FakeSkillRegistry({ skills: [] })).compile(OPUS)

    expect(compiled.skipped).toEqual([{ id: 'skills.listing', reason: ESkipReason.Empty }])
    expect(compiled.blocks).toEqual([{ text: 'You are Atlas.' }])
  })

  it('reflects a mid-session reload without the memo serving the old listing', async () => {
    const skills = new FakeSkillRegistry({
      skills: [fakeSkill({ name: 'research' })],
      onReload: () => [fakeSkill({ name: 'research' }), fakeSkill({ name: 'grilling' })],
    })
    const prompts = registryHolding(skills)

    expect(prompts.compile(OPUS).blocks[0]?.text).not.toContain('grilling')

    await skills.reload()

    expect(prompts.compile(OPUS).blocks[0]?.text).toContain('grilling')
  })

  it('appears once a reload finds the first model-invocable skill', async () => {
    const skills = new FakeSkillRegistry({
      skills: [],
      onReload: () => [fakeSkill({ name: 'research' })],
    })
    const prompts = registryHolding(skills)

    expect(prompts.compile(OPUS).parts.map((part) => part.id)).toEqual(['identity'])

    await skills.reload()

    expect(prompts.compile(OPUS).parts.map((part) => part.id)).toEqual([
      'identity',
      'skills.listing',
    ])
  })
})
