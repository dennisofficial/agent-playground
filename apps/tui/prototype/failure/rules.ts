// PROTOTYPE — throwaway. The two rules under test, kept apart from the drawing so the difference
// between them is a diff rather than an argument.

import type { ToolCall } from '../../src/store'
import { classify, EToolClass, inputOf, str, type Classification, type Read } from '../../src/store/tools'
import { CWD } from '../../src/store/tools/__tests__/fixture'

const STAGES = /&&|\|\||\||;/

const CD = /^cd\s+\S+\s*&&\s*/

/**
 * The exit fix, as a lens over a classification rather than an edit to `bash.ts` — so the two rules
 * can be toggled apart and the difference between them is visible rather than argued.
 */
function withExitFix(args: { call: ToolCall; reading: Classification }): Classification {
  if (!args.reading.failed) return args.reading
  if (args.reading.klass !== EToolClass.Gathered) return args.reading
  if (args.call.name !== 'bash') return args.reading

  const command = str(inputOf(args.call).command) ?? ''
  const first = command.split('\n')[0]?.trim() ?? command
  const stages = first
    .replace(CD, '')
    .split(STAGES)
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0)

  return stages.length > 1 ? { ...args.reading, failed: false } : args.reading
}

type Row =
  | { kind: 'sentence'; key: string; reads: readonly Read[] }
  | { kind: 'alone'; key: string; read: Read }

/** `segmentsOf`, with the pull-out rule optionally in force. Deliberately a copy — the point is to
 *  diff the two rules, which a shared implementation would hide. */
export function rowsOf(args: { calls: readonly ToolCall[]; pullOut: boolean; exitFix: boolean }): Row[] {
  const rows: Row[] = []

  for (const call of args.calls) {
    const raw = classify({ call, cwd: CWD })
    const reading = args.exitFix ? withExitFix({ call, reading: raw }) : raw
    const read: Read = { call, reading }
    const open = rows.at(-1)
    const joins = reading.klass === EToolClass.Gathered && !(args.pullOut && reading.failed)

    if (joins && open?.kind === 'sentence') {
      rows[rows.length - 1] = { ...open, reads: [...open.reads, read] }
      continue
    }
    if (joins) {
      rows.push({ kind: 'sentence', key: call.callId, reads: [read] })
      continue
    }
    rows.push({ kind: 'alone', key: call.callId, read })
  }

  return rows.map((row) =>
    row.kind === 'sentence' && row.reads.length === 1 && row.reads[0] !== undefined
      ? { kind: 'alone', key: row.key, read: row.reads[0] }
      : row,
  )
}
