import { EDiffLine, type DiffHunk, type DiffLine } from './hunk'

const elision = (elided: number): DiffLine => ({
  kind: EDiffLine.Elision,
  oldNumber: null,
  newNumber: null,
  text: '',
  elided,
})

const flushRun = (args: { run: readonly DiffLine[]; context: number }): DiffLine[] => {
  const { run, context } = args
  if (run.length <= context * 2) return [...run]

  return [
    ...run.slice(0, context),
    elision(run.length - context * 2),
    ...run.slice(run.length - context),
  ]
}

export function collapseUnchanged(args: { hunk: DiffHunk; context: number }): DiffHunk {
  const context = Math.max(0, Math.trunc(args.context))
  const lines: DiffLine[] = []
  let run: DiffLine[] = []

  for (const line of args.hunk.lines) {
    if (line.kind === EDiffLine.Context) {
      run.push(line)
      continue
    }

    lines.push(...flushRun({ run, context }), line)
    run = []
  }

  lines.push(...flushRun({ run, context }))

  return {
    heading: args.hunk.heading,
    oldStart: args.hunk.oldStart,
    newStart: args.hunk.newStart,
    lines,
  }
}
