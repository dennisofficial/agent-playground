import { z } from 'zod'

export const SECRETS_VERSION = 1

export const secretsFileSchema = z.object({
  version: z.literal(SECRETS_VERSION),
  secrets: z.record(z.string(), z.string().min(1)),
})

export type SecretsFile = z.infer<typeof secretsFileSchema>

export const emptySecrets = (): SecretsFile => ({ version: SECRETS_VERSION, secrets: {} })
