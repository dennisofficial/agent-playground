import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { EAccountOrigin, EAuthKind, EAuthProvider } from '@dltech/atlas-core'

import { environmentSourceId, syncEnvironmentAccounts } from '../environment-accounts'
import { movableClock, oauthSecret, openVault, type Vault } from './vault-fixture'

let vault: Vault

const sync = (env: Record<string, string | undefined>) =>
  syncEnvironmentAccounts({ accounts: vault.store, env })

beforeEach(() => {
  vault = openVault(movableClock())
})

afterEach(() => {
  vault.close()
})

describe('syncEnvironmentAccounts', () => {
  it('turns a key in the environment into an account the switcher can see', async () => {
    await sync({ ANTHROPIC_API_KEY: 'sk-ant-from-env' })

    const [account] = await vault.store.list()

    expect(account?.provider).toBe(EAuthProvider.Anthropic)
    expect(account?.origin).toBe(EAccountOrigin.Environment)
    expect(account?.importedFrom).toBe(environmentSourceId('ANTHROPIC_API_KEY'))
    expect((await vault.store.read(account!.id))?.secret).toEqual({
      kind: EAuthKind.ApiKey,
      apiKey: 'sk-ant-from-env',
    })
  })

  it('adds one account however many times it runs', async () => {
    await sync({ ANTHROPIC_API_KEY: 'sk-ant-from-env' })
    await sync({ ANTHROPIC_API_KEY: 'sk-ant-from-env' })

    expect(await vault.store.list()).toHaveLength(1)
  })

  it('follows a key that changed', async () => {
    await sync({ ANTHROPIC_API_KEY: 'first' })
    await sync({ ANTHROPIC_API_KEY: 'second' })

    const [account] = await vault.store.list()

    expect((await vault.store.read(account!.id))?.secret).toEqual({
      kind: EAuthKind.ApiKey,
      apiKey: 'second',
    })
  })

  it('takes the account away with the variable', async () => {
    await sync({ ANTHROPIC_API_KEY: 'sk-ant-from-env' })
    await sync({})

    expect(await vault.store.list()).toEqual([])
  })

  it('leaves an account the operator signed in for alone', async () => {
    const own = await vault.addAccount({ label: 'own', secret: oauthSecret({}) })

    await sync({ ANTHROPIC_API_KEY: 'sk-ant-from-env' })
    await sync({})

    expect((await vault.store.list()).map((account) => account.id)).toEqual([own.id])
  })

  it('knows every provider that reads a key from the environment', async () => {
    await sync({
      OPENROUTER_API_KEY: 'or-key',
      OPENAI_API_KEY: 'oa-key',
      INFERENCE_API_KEY: 'in-key',
    })

    expect((await vault.store.list()).map((account) => account.provider).sort()).toEqual([
      EAuthProvider.Inference,
      EAuthProvider.OpenAI,
      EAuthProvider.OpenRouter,
    ])
  })
})
