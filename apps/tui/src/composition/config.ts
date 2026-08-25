import { join } from 'node:path'

import { atlasDirectory } from '@dltech/atlas-harness'

// A subscription credential is entitled per model: on 2026-08-25 haiku-4-5 answered 200 while
// sonnet-5 and opus-5 answered 429 with no retry-after, which the AI SDK retries three times before
// surfacing an error naming neither the status nor the model.
// docs/research/anthropic-oauth-transport.md
export const DEFAULT_MODEL_ID = 'claude-haiku-4-5-20251001'

export const DEFAULT_THINKING_BUDGET_TOKENS = 2048

export const DEV_DATABASE_NAME = 'dev.db'

export type AtlasConfig = {
  modelId: string
  databaseUrl: string
  keychainService: string | undefined
  thinkingBudgetTokens: number
  freshConversation: boolean
  cwd: string
}

export const devDatabaseUrl = (): string => `file:${join(atlasDirectory(), DEV_DATABASE_NAME)}`

const FRESH_FLAGS: readonly string[] = ['--new', '-n']

const MODEL_FLAG = '--model'

const positiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const modelFromArgv = (argv: readonly string[]): string | undefined => {
  const flag = argv.indexOf(MODEL_FLAG)
  if (flag < 0) return undefined

  const named = argv[flag + 1]
  return named === undefined || named.startsWith('-') ? undefined : named
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value

export function resolveConfig(args: {
  env: Record<string, string | undefined>
  argv: readonly string[]
  cwd: string
  defaultDatabaseUrl: string
}): AtlasConfig {
  return {
    modelId: modelFromArgv(args.argv) ?? nonEmpty(args.env.ATLAS_MODEL) ?? DEFAULT_MODEL_ID,
    databaseUrl: nonEmpty(args.env.ATLAS_DATABASE_URL) ?? args.defaultDatabaseUrl,
    keychainService: nonEmpty(args.env.ATLAS_KEYCHAIN_SERVICE),
    thinkingBudgetTokens: positiveInteger(
      args.env.ATLAS_THINKING_BUDGET,
      DEFAULT_THINKING_BUDGET_TOKENS,
    ),
    freshConversation: args.argv.some((arg) => FRESH_FLAGS.includes(arg)),
    cwd: args.cwd,
  }
}
