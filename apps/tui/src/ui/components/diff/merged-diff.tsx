/**
 * Consecutive edits to one file, drawn as one diff.
 *
 * Each edit's patch is computed against the file as that call left it, so the hunks cannot be
 * rebased onto one coordinate space — the seam between them is a gap of unknown size, drawn like
 * the elision rows a collapsed hunk already gets but with nothing to count. The clipboard patch is
 * the call's own patches concatenated, which IS applicable: applied in order, each one meets the
 * file in exactly the state it was computed against.
 */

import { collapseUnchanged, EDiffLine, type DiffFile, type DiffHunk, type DiffLine } from '@dltech/atlas-core'
import React, { useMemo } from 'react'

import type { ToolCall } from '../../../store'
import { diffOf, outputOf, relativise, str } from '../../../store/tools'
import { DIFF_CONTEXT, DIFF_INSET } from '../blocks/tool-detail'
import { InlineDiff } from './inline-diff'

const SEAM: DiffLine = { kind: EDiffLine.Elision, oldNumber: null, newNumber: null, text: '' }

export function mergedDiffOf(args: {
  calls: readonly ToolCall[]
  cwd: string
  context: number
}): { file: DiffFile; patch: string } | null {
  const settled: DiffFile[] = []
  for (const call of args.calls) {
    const file = diffOf(call)
    if (file === null) return null
    settled.push(file)
  }
  const first = settled[0]
  if (first === undefined) return null

  const hunks: DiffHunk[] = []
  settled.forEach((file, index) => {
    const collapsed = file.hunks.map((hunk) => collapseUnchanged({ hunk, context: args.context }))
    const [head, ...rest] = collapsed
    if (index === 0 || head === undefined) {
      hunks.push(...collapsed)
      return
    }
    hunks.push({ ...head, lines: [SEAM, ...head.lines] }, ...rest)
  })

  return {
    file: {
      path: relativise(first.path, args.cwd),
      previousPath: null,
      added: settled.reduce((total, file) => total + file.added, 0),
      removed: settled.reduce((total, file) => total + file.removed, 0),
      created: false,
      deleted: false,
      hunks,
    },
    patch: args.calls
      .map((call) => str(outputOf(call).diff) ?? '')
      .filter((diff) => diff.length > 0)
      .join('\n'),
  }
}

export function MergedDiff(props: {
  calls: readonly ToolCall[]
  inner: number
  cwd: string
}): React.ReactNode {
  const merged = useMemo(
    () => mergedDiffOf({ calls: props.calls, cwd: props.cwd, context: DIFF_CONTEXT }),
    [props.calls, props.cwd],
  )
  if (merged === null) return null

  return (
    <box marginLeft={DIFF_INSET} marginTop={1}>
      <InlineDiff
        file={merged.file}
        width={Math.max(24, props.inner - DIFF_INSET)}
        patch={merged.patch}
      />
    </box>
  )
}
