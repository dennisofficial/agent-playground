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
