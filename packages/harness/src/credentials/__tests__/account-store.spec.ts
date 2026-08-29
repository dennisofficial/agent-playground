import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EAccountOrigin,
  EAccountStatus,
  EAuthKind,
  EAuthProvider,
  type AccountSecret,
  type ClockPort,
} from '@dltech/atlas-core'

import { fileAccountStore, type AccountStore } from '../account-store'
import { CredentialError, ECredentialFailure } from '../credential-error'

const TOKEN = 'sk-ant-oat01-not-a-real-token'

const oauthSecret = (accessToken = TOKEN): AccountSecret => ({
  kind: EAuthKind.Oauth,
  tokens: { accessToken, refreshToken: 'refresh-1', expiresAt: '2026-01-01T12:00:00.000Z' },
})

let directory: string
let ticks = 0

const clock: ClockPort = {
  now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + ticks++ * 1_000).toISOString(),
}

const storeIn = (where: string): AccountStore =>
  fileAccountStore({ file: join(where, 'auth.json'), keyFile: join(where, 'key'), clock })

let store: AccountStore

const addAnthropic = (label: string, secret: AccountSecret = oauthSecret()) =>
  store.add({
    provider: EAuthProvider.Anthropic,
    label,
    secret,
    origin: EAccountOrigin.Login,
  })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atlas-vault-'))
  ticks = 0
  store = storeIn(directory)
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the account store on a file', () => {
  it('reads back an account it stored', async () => {
    const added = await addAnthropic('work')

    expect(await store.read(added.id)).toEqual({ ...added, secret: oauthSecret() })
  })

  it('is empty rather than broken before anything has been written', async () => {
    expect(await store.list()).toEqual([])
    expect(await store.activeFor(EAuthProvider.Anthropic)).toBeUndefined()
  })

  it('keeps every account, not just the last one', async () => {
    await addAnthropic('work')
    await addAnthropic('personal')

    expect((await store.list()).map((account) => account.label)).toEqual(['work', 'personal'])
  })

  it('hands out no secrets when it lists', async () => {
    await addAnthropic('work')

    expect(JSON.stringify(await store.list())).not.toContain(TOKEN)
  })

  it('writes no token in the clear', async () => {
    await addAnthropic('work')

    expect(readFileSync(join(directory, 'auth.json'), 'utf8')).not.toContain(TOKEN)
  })

  it('keeps the vault and its key readable only by their owner', async () => {
    await addAnthropic('work')

    const mode = (name: string): number => statSync(join(directory, name)).mode & 0o777

    expect(mode('auth.json')).toBe(0o600)
    expect(mode('key')).toBe(0o600)
  })

  it('makes the first account of a provider the active one', async () => {
    const first = await addAnthropic('work')
    await addAnthropic('personal')

    expect(await store.activeFor(EAuthProvider.Anthropic)).toBe(first.id)
  })

  it('moves the active account when asked, and only for that provider', async () => {
    await addAnthropic('work')
    const personal = await addAnthropic('personal')

    await store.setActive({ provider: EAuthProvider.Anthropic, accountId: personal.id })

    expect(await store.activeFor(EAuthProvider.Anthropic)).toBe(personal.id)
    expect(await store.activeFor(EAuthProvider.OpenAI)).toBeUndefined()
  })

  it('forgets an account it removed, and stops pointing at it', async () => {
    const account = await addAnthropic('work')

    await store.remove(account.id)

    expect(await store.list()).toEqual([])
    expect(await store.activeFor(EAuthProvider.Anthropic)).toBeUndefined()
    expect(await store.read(account.id)).toBeUndefined()
  })

  it('replaces a secret in place and clears a status the refresh disproved', async () => {
    const account = await addAnthropic('work')
    await store.setStatus({ accountId: account.id, status: EAccountStatus.Expired })

    await store.replaceSecret({ accountId: account.id, secret: oauthSecret('rotated') })

    const stored = await store.read(account.id)
    expect(stored?.secret).toEqual(oauthSecret('rotated'))
    expect(stored?.status).toBe(EAccountStatus.Active)
    expect(stored?.updatedAt).not.toBe(account.updatedAt)
  })

  it('survives another process having written between two of its own writes', async () => {
    const account = await addAnthropic('work')

    const foreign = storeIn(directory)
    await foreign.add({
      provider: EAuthProvider.Anthropic,
      label: 'from-elsewhere',
      secret: oauthSecret('other'),
      origin: EAccountOrigin.Login,
    })

    await store.setStatus({ accountId: account.id, status: EAccountStatus.Limited })

    expect((await store.list()).map((entry) => entry.label)).toEqual(['work', 'from-elsewhere'])
  })

  it('keeps concurrent writes from losing one another', async () => {
    await Promise.all([addAnthropic('one'), addAnthropic('two'), addAnthropic('three')])

    expect(await store.list()).toHaveLength(3)
  })

  it('refuses a vault it cannot parse instead of starting empty over the top of it', async () => {
    writeFileSync(join(directory, 'auth.json'), '{ not json')

    expect(store.list()).rejects.toThrow(CredentialError)
  })

  it('refuses a vault written under another key', async () => {
    await addAnthropic('work')
    const wrongKey = fileAccountStore({
      file: join(directory, 'auth.json'),
      keyFile: join(directory, 'other-key'),
      clock,
    })

    const [account] = await wrongKey.list()
    const failure = await wrongKey.read(account!.id).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CredentialError)
    expect((failure as CredentialError).failure).toBe(ECredentialFailure.Unreadable)
  })
})
