import { z } from 'zod'

import { accountIdSchema, accountSchema, EAuthProvider } from '@dltech/atlas-core'

export const VAULT_VERSION = 1

export const sealedAccountSchema = accountSchema.extend({ secret: z.string().min(1) })

export type SealedAccount = z.infer<typeof sealedAccountSchema>

export const vaultFileSchema = z.object({
  version: z.literal(VAULT_VERSION),
  accounts: z.array(sealedAccountSchema),
  active: z.partialRecord(z.enum(EAuthProvider), accountIdSchema),
})

export type VaultFile = z.infer<typeof vaultFileSchema>

export const emptyVault = (): VaultFile => ({ version: VAULT_VERSION, accounts: [], active: {} })

export const versionedFileSchema = z.looseObject({ version: z.number() })

export const vaultEnvelopeSchema = z.object({
  version: z.literal(VAULT_VERSION),
  accounts: z.array(z.unknown()),
  active: z.record(z.string(), z.unknown()),
})

export type VaultEnvelope = z.infer<typeof vaultEnvelopeSchema>

export interface VaultRemainder {
  readonly accounts: readonly unknown[]
  readonly active: Readonly<Record<string, unknown>>
}

export const emptyRemainder = (): VaultRemainder => ({ accounts: [], active: {} })

export interface VaultReading {
  readonly vault: VaultFile
  readonly remainder: VaultRemainder
}

const providerIsKnown = (provider: string): boolean =>
  z.enum(EAuthProvider).safeParse(provider).success

const namedAccountSchema = z.looseObject({ provider: z.string() })

const belongsToAnotherBuild = (entry: unknown): boolean => {
  const named = namedAccountSchema.safeParse(entry)

  return named.success && !providerIsKnown(named.data.provider)
}

export const readVaultEnvelope = (envelope: VaultEnvelope): VaultReading | undefined => {
  const active = Object.entries(envelope.active)
  const parsed = vaultFileSchema.safeParse({
    version: envelope.version,
    accounts: envelope.accounts.filter((entry) => !belongsToAnotherBuild(entry)),
    active: Object.fromEntries(active.filter(([provider]) => providerIsKnown(provider))),
  })
  if (!parsed.success) return undefined

  return {
    vault: parsed.data,
    remainder: {
      accounts: envelope.accounts.filter((entry) => belongsToAnotherBuild(entry)),
      active: Object.fromEntries(active.filter(([provider]) => !providerIsKnown(provider))),
    },
  }
}

export const withRemainder = (args: { vault: VaultFile; remainder: VaultRemainder }): unknown => ({
  version: args.vault.version,
  accounts: [...args.vault.accounts, ...args.remainder.accounts],
  active: { ...args.vault.active, ...args.remainder.active },
})
