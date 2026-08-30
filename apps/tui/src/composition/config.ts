export const DEFAULT_MODEL_ID = 'claude-haiku-4-5-20251001'

export const TITLER_MODEL_ID = 'claude-haiku-4-5-20251001'

export const SUMMARISER_MODEL_ID = 'claude-sonnet-5'

export const DEFAULT_THINKING_BUDGET_TOKENS = 2048

export enum EOpenMode {
  New = 'new',
  Continue = 'continue',
  Resume = 'resume',
}

export type OpenRequest =
  | { mode: EOpenMode.New }
  | { mode: EOpenMode.Continue }
  | { mode: EOpenMode.Resume; threadId: string }

export type AtlasConfig = {
  modelId: string | undefined
  databaseUrl: string
  keychainService: string | undefined
  thinkingBudgetTokens: number | undefined
  open: OpenRequest
  cwd: string
}

const CONTINUE_FLAGS: readonly string[] = ['--continue', '-c']

const RESUME_FLAG = '--resume'

const MODEL_FLAG = '--model'

const positiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const valueAfter = ({
  argv,
  flag,
}: {
  argv: readonly string[]
  flag: string
}): string | undefined => {
  const at = argv.indexOf(flag)
  if (at < 0) return undefined

  const named = argv[at + 1]
  return named === undefined || named.startsWith('-') ? undefined : named
}

const modelFromArgv = (argv: readonly string[]): string | undefined =>
  valueAfter({ argv, flag: MODEL_FLAG })

/**
 * A launch opens a new thread unless it says otherwise, because resuming silently prepends the last
 * conversation and bills for it on the first turn.
 */
const openFromArgv = (argv: readonly string[]): OpenRequest => {
  const threadId = valueAfter({ argv, flag: RESUME_FLAG })
  if (threadId !== undefined) return { mode: EOpenMode.Resume, threadId }

  const asked = argv.includes(RESUME_FLAG) || argv.some((arg) => CONTINUE_FLAGS.includes(arg))
  return asked ? { mode: EOpenMode.Continue } : { mode: EOpenMode.New }
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
    modelId: modelFromArgv(args.argv) ?? nonEmpty(args.env.ATLAS_MODEL),
    databaseUrl: nonEmpty(args.env.ATLAS_DATABASE_URL) ?? args.defaultDatabaseUrl,
    keychainService: nonEmpty(args.env.ATLAS_KEYCHAIN_SERVICE),
    thinkingBudgetTokens: positiveInteger(args.env.ATLAS_THINKING_BUDGET),
    open: openFromArgv(args.argv),
    cwd: args.cwd,
  }
}
