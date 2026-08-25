import { describe, expect, it } from 'bun:test'

import { toEventId, type Assembled, type ProviderIdentity } from '@dltech/atlas-core'

import { toInstructions } from '../instructions'
import { toProviderPrompt } from '../provider-prompt'

const provider: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }

const assembled: Assembled = {
  system: [
    { text: 'You are Atlas.' },
    { text: 'Project rules.', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
  ],
  messages: [
    {
      message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
      origin: { eventId: toEventId('evt-1'), seq: 1 },
    },
  ],
}

describe('toProviderPrompt', () => {
  it('hands the system blocks over as instructions', () => {
    expect(toProviderPrompt({ assembled, provider }).instructions).toEqual(assembled.system)
  })

  it('hands the bare messages over, dropping the provenance the provider must never see', () => {
    const prompt = toProviderPrompt({ assembled, provider })

    expect(prompt.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'what changed?' }] }])
    expect(JSON.stringify(prompt)).not.toContain('evt-1')
  })

  it('carries the provider identity', () => {
    expect(toProviderPrompt({ assembled, provider }).provider).toEqual(provider)
  })
})

describe('toInstructions', () => {
  it('turns each system block into its own system message', () => {
    expect(toInstructions(assembled.system)).toEqual([
      { role: 'system', content: 'You are Atlas.' },
      {
        role: 'system',
        content: 'Project rules.',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
    ])
  })

  it('omits the provider options key on a block that has none', () => {
    const [first] = toInstructions([{ text: 'You are Atlas.' }])

    expect(first && 'providerOptions' in first).toBe(false)
  })
})
