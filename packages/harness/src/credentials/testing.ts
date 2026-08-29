import {
  EAuthKind,
  toAccountId,
  type Credential,
  type CredentialPort,
} from '@dltech/atlas-core'

const AN_HOUR_MS = 3_600_000

export const oauthCredential = (args: {
  accessToken: string
  accountId?: string
  expiresAt?: string
}): Credential => ({
  kind: EAuthKind.Oauth,
  accountId: toAccountId(args.accountId ?? 'acc_test'),
  accessToken: args.accessToken,
  expiresAt: args.expiresAt ?? new Date(Date.now() + AN_HOUR_MS).toISOString(),
})

export const apiKeyCredential = (args: { apiKey: string; accountId?: string }): Credential => ({
  kind: EAuthKind.ApiKey,
  accountId: toAccountId(args.accountId ?? 'acc_test'),
  apiKey: args.apiKey,
})

export const credentialsHandingOut = (...credentials: readonly Credential[]): CredentialPort => {
  let handed = 0

  return {
    read: async () => {
      const credential = credentials[Math.min(handed, credentials.length - 1)]
      handed += 1
      if (credential === undefined) throw new Error('no credential was scripted')
      return credential
    },
  }
}
