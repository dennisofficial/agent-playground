import { describe, expect, it } from 'bun:test'

import { EPromptAgent, modelEntry, type PromptContext } from '@dltech/atlas-core'

import { AtlasIdentityFragment } from '../fragments/identity'

const contextFor = (agent: EPromptAgent): PromptContext => ({
  agent,
  provider: { id: 'anthropic-oauth', modelId: 'claude-opus-5' },
  model: modelEntry('claude-opus-5'), projectDirectory: '/w'
})

describe('the identity fragment across the agent axis', () => {
  it('tells the main agent who it is', () => {
    expect(new AtlasIdentityFragment().applies(contextFor(EPromptAgent.Main))).toBe(true)
  })

  it('is withheld from a sub-agent, whose type supplies its identity instead', () => {
    expect(new AtlasIdentityFragment().applies(contextFor(EPromptAgent.Sub))).toBe(false)
  })
})
