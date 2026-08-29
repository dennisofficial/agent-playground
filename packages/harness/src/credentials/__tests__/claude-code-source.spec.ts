import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { EAccountOrigin, EAuthKind } from '@dltech/atlas-core'

import {
  ClaudeCodeSource,
  CLAUDE_CODE_SOURCE_ID,
  importClaudeCodeAccount,
  type ClaudeCodePayloadStore,
} from '../claude-code-source'
import { movableClock, oauthSecret, openVault, tokens, type Vault } from './vault-fixture'
import {
  FAKE_ACCESS_TOKEN,
  FAKE_EXPIRES_AT_ISO,
  FAKE_REFRESH_TOKEN,
  fakeClaudeCredentialBlob,
} from './fixtures'

const payloadsHolding = (initial: string | undefined): ClaudeCodePayloadStore & { held: () => string | undefined } => {
  let payload = initial

  return {
    read: async () => payload,
    write: async (next) => {
      payload = next
    },
    held: () => payload,
  }
}

let vault: Vault

beforeEach(() => {
  vault = openVault(movableClock())
})

afterEach(() => {
  vault.close()
})

describe('ClaudeCodeSource', () => {
  it('reads the whole pair, refresh token included', async () => {
    const source = new ClaudeCodeSource(payloadsHolding(fakeClaudeCredentialBlob()))

    expect(await source.read()).toEqual({
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: FAKE_EXPIRES_AT_ISO,
      scopes: ['user:inference'],
    })
  })

  it('is empty rather than broken when Claude Code has never signed in', async () => {
    expect(await new ClaudeCodeSource(payloadsHolding(undefined)).read()).toBeUndefined()
  })

  it('treats a payload it cannot parse as no credential at all', async () => {
    expect(await new ClaudeCodeSource(payloadsHolding('{ not json')).read()).toBeUndefined()
  })

  it('writes a rotated pair back in the shape Claude Code reads', async () => {
    const payloads = payloadsHolding(fakeClaudeCredentialBlob())
    const source = new ClaudeCodeSource(payloads)

    await source.write(
      tokens({ access: 'rotated-access', refresh: 'rotated-refresh', expiresAt: FAKE_EXPIRES_AT_ISO }),
    )

    const written = JSON.parse(payloads.held() ?? '{}') as {
      claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number }
      mcpOAuth: unknown
    }

    expect(written.claudeAiOauth.accessToken).toBe('rotated-access')
    expect(written.claudeAiOauth.refreshToken).toBe('rotated-refresh')
    expect(written.claudeAiOauth.expiresAt).toBe(Date.parse(FAKE_EXPIRES_AT_ISO))
    expect(written.mcpOAuth).toEqual({})
  })

  it('round-trips through its own writer', async () => {
    const payloads = payloadsHolding(fakeClaudeCredentialBlob())
    const source = new ClaudeCodeSource(payloads)
    const rotated = tokens({ access: 'a', refresh: 'r' })

    await source.write(rotated)

    expect(await source.read()).toMatchObject({ accessToken: 'a', refreshToken: 'r' })
  })
})

describe('importClaudeCodeAccount', () => {
  it('adopts an existing Claude Code login so the operator never sees a login screen', async () => {
    const source = new ClaudeCodeSource(payloadsHolding(fakeClaudeCredentialBlob()))

    const imported = await importClaudeCodeAccount({ accounts: vault.store, source })

    expect(imported?.origin).toBe(EAccountOrigin.Imported)
    expect(imported?.importedFrom).toBe(CLAUDE_CODE_SOURCE_ID)
    expect(imported?.kind).toBe(EAuthKind.Oauth)
    expect((await vault.store.read(imported!.id))?.secret).toMatchObject({
      kind: EAuthKind.Oauth,
      tokens: { refreshToken: FAKE_REFRESH_TOKEN },
    })
  })

  it('imports once, so a credential the operator removed does not come back', async () => {
    const source = new ClaudeCodeSource(payloadsHolding(fakeClaudeCredentialBlob()))

    const first = await importClaudeCodeAccount({ accounts: vault.store, source })
    const second = await importClaudeCodeAccount({ accounts: vault.store, source })

    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    expect(await vault.store.list()).toHaveLength(1)
  })

  it('leaves a vault that already holds its own login alone', async () => {
    await vault.addAccount({ label: 'own', secret: oauthSecret({}) })
    const source = new ClaudeCodeSource(payloadsHolding(undefined))

    expect(await importClaudeCodeAccount({ accounts: vault.store, source })).toBeUndefined()
    expect(await vault.store.list()).toHaveLength(1)
  })
})
