import { resolve } from 'node:path'

import type { ModelRef } from '@dltech/atlas-core'

import { expandHome } from '../ui/paths'

export const DEFAULT_MODEL_REF: ModelRef = {
  providerId: 'anthropic',
  modelId: 'claude-haiku-4-5',
}

export const TITLER_MODEL_ID = 'claude-haiku-4-5-20251001'

export const SUMMARISER_MODEL_ID = 'claude-sonnet-5'

export enum EOpenMode {
  New = 'new',
  Continue = 'continue',
  Resume = 'resume',
}

export type OpenRequest =
  | { mode: EOpenMode.New }
  | { mode: EOpenMode.Continue }
  | { mode: EOpenMode.Resume; threadId: string }

/**
 * What a launch decides for itself and nothing that outlives it. Anything a run configures is a
 * setting, reachable through the layered file and the environment variable that setting declares,
 * so what is left here is the flags that mean "for this launch" and would be wrong to persist.
 */
export type AtlasConfig = {
  model: string | undefined
  open: OpenRequest
  cwd: string
}

const CONTINUE_FLAGS: readonly string[] = ['--continue', '-c']

const RESUME_FLAG = '--resume'

const MODEL_FLAG = '--model'

const DIRECTORY_FLAG = '--cwd'

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

/**
 * Bun reads its tsconfig from the process working directory, so a source launch has to be started
 * from inside this workspace or it loses `emitDecoratorMetadata` and every injected constructor
 * with it. The directory Atlas works in is therefore a launch argument, not the directory bun ran in.
 */
const directoryFromArgv = (args: {
  argv: readonly string[]
  cwd: string
  home: string | undefined
}): string => {
  const named = valueAfter({ argv: args.argv, flag: DIRECTORY_FLAG })
  if (named === undefined) return args.cwd

  return resolve(args.cwd, expandHome({ path: named, home: args.home ?? '' }))
}

export function resolveConfig(args: {
  argv: readonly string[]
  cwd: string
  home: string | undefined
}): AtlasConfig {
  return {
    model: modelFromArgv(args.argv),
    open: openFromArgv(args.argv),
    cwd: directoryFromArgv({ argv: args.argv, cwd: args.cwd, home: args.home }),
  }
}
