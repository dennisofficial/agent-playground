import { getTreeSitterClient, treeSitterToTextChunks, type TextChunk } from '@opentui/core'

import { codeSyntaxStyleFor } from './syntax-style'

export const DIFF_ELLIPSIS = '…'

export type HighlightedRows = readonly (readonly TextChunk[])[] | null

const CACHE = new Map<string, HighlightedRows>()
const CACHE_LIMIT = 128

function remember(key: string, value: HighlightedRows): HighlightedRows {
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next()
    if (!oldest.done) CACHE.delete(oldest.value)
  }
  CACHE.set(key, value)
  return value
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
  if (highlights.length === 0) return remember(key, null)

  const chunks = treeSitterToTextChunks(
    content,
    highlights,
    codeSyntaxStyleFor(args.filetype),
    // Concealment DELETES characters, which would take the row out of alignment with the gutter
    // numbering it beside it.
    { enabled: false },
  )
  return remember(key, chunksByLine({ chunks, lines: args.lines.length }))
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
