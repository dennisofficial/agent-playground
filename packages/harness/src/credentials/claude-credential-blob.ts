import type { Credential } from '@dltech/atlas-core'
import { z } from 'zod'

import { CredentialError, ECredentialFailure } from './credential-error'

const claudeCredentialBlobSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().int().positive(),
  }),
})

const unreadableCredential = (detail: string): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.Unreadable,
    message: `The Claude Code credential could not be read: ${detail}. Run \`claude\` once to sign in again.`,
  })

const parseJsonWithoutQuotingIt = (payload: string): unknown => {
  try {
    return JSON.parse(payload)
  } catch {
    throw unreadableCredential('the stored value is not valid JSON')
  }
}

const expiresAtIsoFromEpochMillis = (epochMillis: number): string =>
  new Date(epochMillis).toISOString()

export const parseClaudeCredentialBlob = (payload: string): Credential => {
  const parsed = claudeCredentialBlobSchema.safeParse(parseJsonWithoutQuotingIt(payload))

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? 'the credential root' : issue.path.join('.')))
      .join(', ')

    throw unreadableCredential(`unexpected shape at ${fields}`)
  }

  return {
    accessToken: parsed.data.claudeAiOauth.accessToken,
    expiresAt: expiresAtIsoFromEpochMillis(parsed.data.claudeAiOauth.expiresAt),
  }
}
