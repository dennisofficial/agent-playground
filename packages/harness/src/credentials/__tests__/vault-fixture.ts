import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EAccountOrigin,
  EAuthKind,
  EAuthProvider,
  type Account,
  type AccountSecret,
  type ClockPort,
  type OauthTokens,
} from '@dltech/atlas-core'

import { fileAccountStore, type AccountStore } from '../account-store'

export const NOW = '2026-01-01T12:00:00.000Z'

export const minutesFromNow = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString()

export const movableClock = (): ClockPort & { set: (now: string) => void } => {
  let now = NOW
  return {
    now: () => now,
    set: (next: string) => {
      now = next
    },
  }
}

export const tokens = (args: {
  access?: string
  refresh?: string
  expiresAt?: string
  accountId?: string
}): OauthTokens => ({
  accessToken: args.access ?? 'access-1',
  refreshToken: args.refresh ?? 'refresh-1',
  expiresAt: args.expiresAt ?? minutesFromNow(60),
  ...(args.accountId === undefined ? {} : { accountId: args.accountId }),
})

export const oauthSecret = (args: Parameters<typeof tokens>[0] = {}): AccountSecret => ({
  kind: EAuthKind.Oauth,
  tokens: tokens(args),
})

export type Vault = {
  store: AccountStore
  directory: string
  addAccount: (args: {
    label: string
    secret: AccountSecret
    provider?: EAuthProvider
    importedFrom?: string
  }) => Promise<Account>
  close: () => void
}

export const openVault = (clock: ClockPort): Vault => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-credentials-'))
  const store = fileAccountStore({
    file: join(directory, 'auth.json'),
    keyFile: join(directory, 'key'),
    clock,
  })

  return {
    store,
    directory,
    addAccount: ({ label, secret, provider, importedFrom }) =>
      store.add({
        provider: provider ?? EAuthProvider.Anthropic,
        label,
        secret,
        origin: importedFrom === undefined ? EAccountOrigin.Login : EAccountOrigin.Imported,
        ...(importedFrom === undefined ? {} : { importedFrom }),
      }),
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}
