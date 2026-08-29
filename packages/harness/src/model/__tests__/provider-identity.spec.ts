import { describe, expect, it } from 'bun:test'

import { AiSdkModelPort } from '../ai-sdk-model-port'
import { GATEWAY_PROVIDER_ID, providerIdentityOf } from '../provider-identity'
import { createSwitchableModel } from '../switchable-model'
import { scriptedModel } from '../testing/scripted-model'

type Choice = { provider: string; modelId: string }

const switchableOver = (initial: Choice) =>
  createSwitchableModel<Choice>({
    initial,
    keyOf: (choice) => `${choice.provider}:${choice.modelId}`,
    build: (choice) => scriptedModel({ script: [{ text: 'ok' }], ...choice }),
  })

describe('providerIdentityOf', () => {
  it('reads the identity the model reports at the moment it is asked', () => {
    const switchable = switchableOver({ provider: 'anthropic', modelId: 'claude-opus-5' })

    expect(providerIdentityOf(switchable.model)).toEqual({ id: 'anthropic', modelId: 'claude-opus-5' })

    switchable.select({ provider: 'openai', modelId: 'gpt-5-codex' })

    expect(providerIdentityOf(switchable.model)).toEqual({ id: 'openai', modelId: 'gpt-5-codex' })
  })

  it('names the gateway for a model given as a bare id, since there is nothing to read it off', () => {
    expect(providerIdentityOf('claude-opus-5')).toEqual({
      id: GATEWAY_PROVIDER_ID,
      modelId: 'claude-opus-5',
    })
  })
})

describe('the identity a model port reports', () => {
  it('follows a switch rather than freezing whichever model was selected first', () => {
    const switchable = switchableOver({ provider: 'anthropic', modelId: 'claude-opus-5' })
    const port = new AiSdkModelPort({ model: switchable.model })

    expect(port.identity).toEqual({ id: 'anthropic', modelId: 'claude-opus-5' })

    switchable.select({ provider: 'openai', modelId: 'gpt-5-codex' })

    expect(port.identity).toEqual({ id: 'openai', modelId: 'gpt-5-codex' })
  })

  it('crosses vendors, so the provider id moves with the model and not only the model id', () => {
    const switchable = switchableOver({ provider: 'anthropic', modelId: 'claude-opus-5' })
    const port = new AiSdkModelPort({ model: switchable.model })

    switchable.select({ provider: 'openai', modelId: 'gpt-5-codex' })

    expect(port.identity.id).toBe('openai')
  })

  it('hands out a plain snapshot, so a caller that captures it bills the model it captured', () => {
    const switchable = switchableOver({ provider: 'anthropic', modelId: 'claude-opus-5' })
    const port = new AiSdkModelPort({ model: switchable.model })

    const captured = port.identity
    switchable.select({ provider: 'anthropic', modelId: 'claude-haiku-4-5' })

    expect(captured).toEqual({ id: 'anthropic', modelId: 'claude-opus-5' })
    expect(port.identity).toEqual({ id: 'anthropic', modelId: 'claude-haiku-4-5' })
  })

  it('lets a caller declare an identity the model cannot report, and then keeps it', () => {
    const switchable = switchableOver({ provider: 'anthropic', modelId: 'claude-opus-5' })
    const declared = { id: 'my-gateway', modelId: 'house-model' }
    const port = new AiSdkModelPort({ model: switchable.model, identity: declared })

    switchable.select({ provider: 'openai', modelId: 'gpt-5-codex' })

    expect(port.identity).toEqual(declared)
  })
})
