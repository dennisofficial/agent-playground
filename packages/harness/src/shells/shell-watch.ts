import { messageOf } from './shell-process'

export const MATCH_SETTLE_MS = 200
export const MATCHED_LINES_CAP = 200

export type CompiledWatch =
  | { ok: true; pattern?: RegExp | undefined }
  | { ok: false; reason: string }

export function compileWatch(source: string | undefined): CompiledWatch {
  if (source === undefined) return { ok: true }

  try {
    return { ok: true, pattern: new RegExp(source) }
  } catch (error) {
    return {
      ok: false,
      reason: `watch ${JSON.stringify(source)} is not a regular expression: ${messageOf(error)}`,
    }
  }
}

export type MatchedLines = {
  lines: readonly string[]
  matchCount: number
  disarmed: boolean
}

export type LineMatcher = {
  append(chunk: string): void
  pending(): boolean
  take(): MatchedLines
}

export function createLineMatcher({ pattern, cap }: { pattern: RegExp; cap: number }): LineMatcher {
  let remainder = ''
  let matched: string[] = []
  let delivered = 0
  let disarmed = false

  const test = (line: string): void => {
    if (!pattern.test(line)) return

    matched.push(line)
    if (delivered + matched.length >= cap) disarmed = true
  }

  return {
    append: (chunk) => {
      if (disarmed || chunk === '') return

      const lines = (remainder + chunk).split('\n')
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        if (disarmed) return
        test(line)
      }
    },

    pending: () => matched.length > 0,

    take: () => {
      const lines = matched
      matched = []
      delivered += lines.length
      return { lines, matchCount: lines.length, disarmed }
    },
  }
}
