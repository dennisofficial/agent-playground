import { countLineBreaks, render, type Tail } from '../../shells/shell-process'

export const MAXIMUM_OUTPUT_CHARACTERS = 30_000

const HALF_OUTPUT_CHARACTERS = Math.floor(MAXIMUM_OUTPUT_CHARACTERS / 2)

/**
 * Each stream is budgeted rather than the joined text: keeping the last N characters of stdout
 * followed by stderr throws stdout away first, so a command loud on both showed only stderr.
 */
function budgetsFor(args: { stdout: number; stderr: number }): { stdout: number; stderr: number } {
  if (args.stdout + args.stderr <= MAXIMUM_OUTPUT_CHARACTERS) return args
  if (args.stdout <= HALF_OUTPUT_CHARACTERS) {
    return { stdout: args.stdout, stderr: MAXIMUM_OUTPUT_CHARACTERS - args.stdout }
  }
  if (args.stderr <= HALF_OUTPUT_CHARACTERS) {
    return { stdout: MAXIMUM_OUTPUT_CHARACTERS - args.stderr, stderr: args.stderr }
  }

  return {
    stdout: HALF_OUTPUT_CHARACTERS,
    stderr: MAXIMUM_OUTPUT_CHARACTERS - HALF_OUTPUT_CHARACTERS,
  }
}

const withoutTrailingBreaks = (text: string): string => text.replace(/\n+$/, '')

function clampTail(args: { tail: Tail; budget: number }): Tail {
  const text = withoutTrailingBreaks(args.tail.text)
  if (text.length <= args.budget) return { ...args.tail, text }

  const kept = text.slice(-args.budget)
  return {
    text: kept,
    droppedLines: args.tail.droppedLines + countLineBreaks(text.slice(0, text.length - kept.length)),
    truncated: true,
  }
}

export function mergeStreams(args: { stdout: Tail; stderr: Tail }): { text: string; truncated: boolean } {
  const budgets = budgetsFor({
    stdout: withoutTrailingBreaks(args.stdout.text).length,
    stderr: withoutTrailingBreaks(args.stderr.text).length,
  })

  const streams = [
    clampTail({ tail: args.stdout, budget: budgets.stdout }),
    clampTail({ tail: args.stderr, budget: budgets.stderr }),
  ]

  const text = streams
    .filter((stream) => stream.text.length > 0)
    .map(render)
    .join('\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()

  return { text, truncated: streams.some((stream) => stream.truncated) }
}

export function renderModelText(args: {
  merged: string
  exitCode: number
  timedOut: boolean
  timeoutMs: number
  maximumTimeoutMs: number
}): string {
  const sections: string[] = []
  if (args.merged.length > 0) sections.push(args.merged)
  if (args.timedOut) {
    sections.push(
      `The command was killed after exceeding its ${args.timeoutMs} ms timeout. If it needs longer than ${args.maximumTimeoutMs} ms, start it again with runInBackground and its ending will be delivered to you whenever it lands.`,
    )
  }
  if (args.exitCode !== 0) sections.push(`Exit code: ${args.exitCode}`)
  if (sections.length === 0) return 'The command completed with no output.'
  return sections.join('\n\n')
}
