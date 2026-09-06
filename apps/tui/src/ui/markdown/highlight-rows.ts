import { getTreeSitterClient, treeSitterToTextChunks, type TextChunk } from '@opentui/core'

import { codeSyntaxStyleFor } from './syntax-style'

export const DIFF_ELLIPSIS = '…'

export type HighlightedRows = readonly (readonly TextChunk[])[] | null

const CACHE = new Map<string, HighlightedRows>()
const CACHE_LIMIT = 128

function remember(args: { key: string; value: HighlightedRows }): HighlightedRows {
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next()
    if (!oldest.done) CACHE.delete(oldest.value)
  }
  CACHE.set(args.key, args.value)
  return args.value
}

function cacheKey(args: { lines: readonly string[]; filetype: string }): string {
  return `${args.filetype} ${args.lines.join('\n')}`
}

export function cachedHighlight(args: {
  lines: readonly string[]
  filetype: string
}): HighlightedRows | undefined {
  return CACHE.get(cacheKey(args))
}

export async function highlightRows(args: {
  lines: readonly string[]
  filetype: string
}): Promise<HighlightedRows> {
  const key = cacheKey(args)
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit

  const content = args.lines.join('\n')
  // The client is process-wide and the renderer tears it down on exit, so a pass still in flight
  // rejects with "TreeSitter client destroyed". A torn-down app is not a bad fragment: swallow it,
  // and do not cache the failure or one shutdown would poison this content for the process.
  const result = await getTreeSitterClient()
    .highlightOnce(content, args.filetype)
    .catch(() => null)
  if (result === null) return null

  const highlights = result.highlights ?? []
  if (highlights.length === 0) return remember({ key, value: null })

  const chunks = treeSitterToTextChunks(
    content,
    highlights,
    codeSyntaxStyleFor(args.filetype),
    // Concealment DELETES characters, which would take the row out of alignment with the gutter
    // numbering it beside it.
    { enabled: false },
  )
  return remember({ key, value: chunksByLine({ chunks, lines: args.lines.length }) })
}

export function chunksByLine(args: {
  chunks: readonly TextChunk[]
  lines: number
}): readonly (readonly TextChunk[])[] {
  const out: TextChunk[][] = Array.from({ length: args.lines }, () => [])
  let line = 0
  for (const chunk of args.chunks) {
    const parts = chunk.text.split('\n')
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) line += 1
      if (line >= args.lines) return out
      const text = parts[index] ?? ''
      if (text.length === 0) continue
      out[line]?.push({ ...chunk, text })
    }
  }
  return out
}

type RowRange = { start: number; end: number }

/**
 * Row breaks for a soft wrap: end-exclusive ranges into the text. A range never starts on the
 * space the previous row broke before — that space belongs to no row, the way a terminal drops
 * the cell it wrapped on.
 */
function wrapRangesOf(args: { text: string; columns: number }): RowRange[] {
  const ranges: RowRange[] = []
  let start = 0
  let lastSpace = -1
  let index = 0
  while (index < args.text.length) {
    if (args.text[index] === ' ') lastSpace = index
    if (index - start < args.columns) {
      index += 1
      continue
    }
    if (lastSpace >= start) {
      ranges.push({ start, end: lastSpace })
      index = lastSpace + 1
    } else {
      ranges.push({ start, end: index })
    }
    start = index
    lastSpace = -1
  }
  if (start < args.text.length || ranges.length === 0) {
    ranges.push({ start, end: args.text.length })
  }
  return ranges
}

/**
 * The wrap counterpart of fitDiffChunks: one logical row becomes as many painted rows as it
 * needs, broken on word boundaries and falling back to a hard break for a word — a path, say —
 * longer than a row. Chunk styles follow their characters across the breaks.
 */
export function wrapDiffChunks(args: {
  chunks: readonly TextChunk[]
  columns: number
}): readonly (readonly TextChunk[])[] {
  const text = args.chunks.reduce((joined, chunk) => joined + chunk.text, '')
  if (text.length <= args.columns || args.columns <= 0) return [args.chunks]

  const rows: TextChunk[][] = []
  let chunkIndex = 0
  let offset = 0
  let absolute = 0
  for (const range of wrapRangesOf({ text, columns: args.columns })) {
    const row: TextChunk[] = []
    while (absolute < range.end && chunkIndex < args.chunks.length) {
      const chunk = args.chunks[chunkIndex]
      if (chunk === undefined) break
      const remaining = chunk.text.length - offset
      if (remaining <= 0) {
        chunkIndex += 1
        offset = 0
        continue
      }
      const droppedBreakSpace = range.start - absolute
      if (droppedBreakSpace > 0) {
        const skipped = Math.min(remaining, droppedBreakSpace)
        offset += skipped
        absolute += skipped
        continue
      }
      const take = Math.min(remaining, range.end - absolute)
      row.push({ ...chunk, text: chunk.text.slice(offset, offset + take) })
      offset += take
      absolute += take
    }
    rows.push(row)
  }
  return rows
}

export function fitDiffChunks(args: {
  chunks: readonly TextChunk[]
  columns: number
}): readonly TextChunk[] {
  const width = args.chunks.reduce((total, chunk) => total + chunk.text.length, 0)
  if (width <= args.columns) return args.chunks

  const budget = Math.max(0, args.columns - DIFF_ELLIPSIS.length)
  const out: TextChunk[] = []
  let used = 0
  for (const chunk of args.chunks) {
    if (used >= budget) break
    const take = Math.min(chunk.text.length, budget - used)
    out.push({ ...chunk, text: chunk.text.slice(0, take) })
    used += take
  }
  const last = out.at(-1)
  out.push({ ...(last ?? { __isChunk: true as const }), text: DIFF_ELLIPSIS })
  return out
}
