import { EDiffLine, type DiffFile, type DiffHunk } from '@dltech/atlas-core'

import { hunkMarker } from '../../diff-layout'

const SIGN_OF: Readonly<Record<EDiffLine, string>> = {
  [EDiffLine.Context]: ' ',
  [EDiffLine.Added]: '+',
  [EDiffLine.Removed]: '-',
  [EDiffLine.Elision]: ' ',
}

function hunkText(hunk: DiffHunk): string[] {
  const heading = hunk.heading.length === 0 ? '' : ` ${hunk.heading}`
  return [
    `${hunkMarker({ hunk })}${heading}`,
    ...hunk.lines
      .filter((line) => line.kind !== EDiffLine.Elision)
      .map((line) => `${SIGN_OF[line.kind]}${line.text}`),
  ]
}

/** A real unified patch: hyphens where the picture shows U+2212, and no elision rows. */
export function patchText(args: { file: DiffFile }): string {
  return [
    `--- a/${args.file.previousPath ?? args.file.path}`,
    `+++ b/${args.file.path}`,
    ...args.file.hunks.flatMap(hunkText),
  ].join('\n')
}
