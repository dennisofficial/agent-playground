import { parseColor, TextAttributes, type RGBA, type TextChunk } from '@opentui/core'

export type DiffSpan = { start: number; end: number }

const textOf = (chunks: readonly TextChunk[]): string =>
  chunks.reduce((joined, chunk) => joined + chunk.text, '')

export function chunksFor(args: {
  text: string
  chunks: readonly TextChunk[] | null
}): readonly TextChunk[] {
  if (args.chunks !== null && textOf(args.chunks) === args.text) return args.chunks
  return [{ __isChunk: true, text: args.text }]
}

export function dimChunks(chunks: readonly TextChunk[]): readonly TextChunk[] {
  return chunks.map((chunk) => ({
    ...chunk,
    attributes: (chunk.attributes ?? 0) | TextAttributes.DIM,
  }))
}

export function emphasiseChunks(args: {
  chunks: readonly TextChunk[]
  span: DiffSpan
  bg: RGBA
}): readonly TextChunk[] {
  const out: TextChunk[] = []
  let at = 0

  for (const chunk of args.chunks) {
    const end = at + chunk.text.length
    const from = Math.max(args.span.start, at)
    const to = Math.min(args.span.end, end)

    if (to <= from) {
      out.push(chunk)
      at = end
      continue
    }

    if (from > at) out.push({ ...chunk, text: chunk.text.slice(0, from - at) })
    out.push({ ...chunk, text: chunk.text.slice(from - at, to - at), bg: args.bg })
    if (to < end) out.push({ ...chunk, text: chunk.text.slice(to - at) })
    at = end
  }

  return out
}

const colourCache = new Map<string, RGBA>()

export function cachedColour(colour: string): RGBA {
  const cached = colourCache.get(colour)
  if (cached) return cached
  const parsed = parseColor(colour)
  colourCache.set(colour, parsed)
  return parsed
}

export function emphasisBg(colour: string): RGBA {
  return cachedColour(colour)
}
