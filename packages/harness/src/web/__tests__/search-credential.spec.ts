import { describe, expect, it } from 'bun:test'

import { EWebSearchBackend, secretNameOf, type SecretsPort } from '@dltech/atlas-core'

import { credentialFor } from '../search'

const secretsHolding = (held: Record<string, string>): SecretsPort => ({
  origin: () => 'test',
  read: (name) => held[name],
  write: () => undefined,
  remove: () => undefined,
})

describe('credentialFor', () => {
  it('hands the backend the secret stored under its own name', () => {
    const secrets = secretsHolding({ [secretNameOf(EWebSearchBackend.Tavily)]: 'tvly-abcd' })

    expect(credentialFor({ backend: EWebSearchBackend.Tavily, secrets })).toBe('tvly-abcd')
  })

  it("does not hand one backend another backend's key", () => {
    const secrets = secretsHolding({ [secretNameOf(EWebSearchBackend.Tavily)]: 'tvly-abcd' })

    expect(credentialFor({ backend: EWebSearchBackend.Exa, secrets })).toBeUndefined()
  })

  it('asks for nothing on behalf of the backend that takes nothing', () => {
    let asked = false
    const secrets: SecretsPort = {
      origin: () => 'test',
      read: (name) => {
        asked = true
        return name
      },
      write: () => undefined,
      remove: () => undefined,
    }

    expect(credentialFor({ backend: EWebSearchBackend.DuckDuckGo, secrets })).toBeUndefined()
    expect(asked).toBe(false)
  })

  it('treats an empty stored value as no key at all', () => {
    const secrets = secretsHolding({ [secretNameOf(EWebSearchBackend.Brave)]: '' })

    expect(credentialFor({ backend: EWebSearchBackend.Brave, secrets })).toBeUndefined()
  })

  it('reads nothing from the environment, whatever the environment holds', () => {
    process.env.TAVILY_API_KEY = 'tvly-from-the-environment'
    try {
      expect(
        credentialFor({ backend: EWebSearchBackend.Tavily, secrets: secretsHolding({}) }),
      ).toBeUndefined()
    } finally {
      delete process.env.TAVILY_API_KEY
    }
  })
})
