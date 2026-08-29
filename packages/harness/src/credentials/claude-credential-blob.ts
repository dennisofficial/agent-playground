import type { OauthTokens } from '@dltech/atlas-core'
import { z } from 'zod'

import { CredentialError, ECredentialFailure } from './credential-error'

const claudeCredentialBlobSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().default(''),
    expiresAt: z.number().int().positive(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().optional(),
  }),
})

export type ClaudeCredential = {
  tokens: OauthTokens
  subscription?: string
}

const unreadableCredential = (detail: string): CredentialError =>
  new CredentialError({
    failure: ECredentialFailure.Unreadable,
    message: `The Claude Code credential could not be read: ${detail}.`,
  })

const parseJsonWithoutQuotingIt = (payload: string): unknown => {
  try {
    return JSON.parse(payload)
  } catch {
    throw unreadableCredential('the stored value is not valid JSON')
  }
}

const parseJsonQuietly = (payload: string): unknown => {
  try {
    return JSON.parse(payload)
  } catch {
    return {}
  }
}

const objectOr = (payload: unknown): Record<string, unknown> =>
  typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}

export const parseClaudeCredentialBlob = (payload: string): ClaudeCredential => {
  const parsed = claudeCredentialBlobSchema.safeParse(parseJsonWithoutQuotingIt(payload))

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? 'the credential root' : issue.path.join('.')))
      .join(', ')

    throw unreadableCredential(`unexpected shape at ${fields}`)
  }

  const oauth = parsed.data.claudeAiOauth

  return {
    tokens: {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: new Date(oauth.expiresAt).toISOString(),
      ...(oauth.scopes === undefined ? {} : { scopes: oauth.scopes }),
    },
    ...(oauth.subscriptionType === undefined ? {} : { subscription: oauth.subscriptionType }),
  }
}

/**
 * Rendered in the shape Claude Code reads, over the top of whatever else the payload carried: the
 * item is shared with a tool that is still running, and `mcpOAuth` sits beside `claudeAiOauth` in
 * the same blob.
 */
export const claudeCredentialBlob = (args: {
  tokens: OauthTokens
  subscription?: string | undefined
  existing?: string | undefined
}): string => {
  const existing = args.existing === undefined ? {} : objectOr(parseJsonQuietly(args.existing))
  const previous = objectOr(existing.claudeAiOauth)

  return JSON.stringify({
    ...existing,
    claudeAiOauth: {
      ...previous,
      accessToken: args.tokens.accessToken,
      refreshToken: args.tokens.refreshToken,
      expiresAt: Date.parse(args.tokens.expiresAt),
      ...(args.tokens.scopes === undefined ? {} : { scopes: args.tokens.scopes }),
      ...(args.subscription === undefined ? {} : { subscriptionType: args.subscription }),
    },
  })
}
