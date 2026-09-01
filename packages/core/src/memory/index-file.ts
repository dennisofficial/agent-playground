export const MAX_INDEX_LINES = 200
export const MAX_INDEX_BYTES = 25_000

export type BoundedIndex = {
  text: string
  lines: number
  bytes: number
  lineCapped: boolean
  byteCapped: boolean
}

const NEWLINE = '\n'

const reasonFor = (args: {
  lines: number
  bytes: number
  lineCapped: boolean
  byteCapped: boolean
}): string => {
  if (args.lineCapped && args.byteCapped) {
    return `${args.lines} lines and ${args.bytes} bytes`
  }
  if (args.lineCapped) return `${args.lines} lines (limit ${MAX_INDEX_LINES})`
  return `${args.bytes} bytes (limit ${MAX_INDEX_BYTES}) — its entries are too long`
}

export function boundedIndex({ content }: { content: string }): BoundedIndex {
  const trimmed = content.trim()
  const lines = trimmed.split(NEWLINE).length
  const bytes = trimmed.length

  const lineCapped = lines > MAX_INDEX_LINES
  const byteCapped = bytes > MAX_INDEX_BYTES

  if (!lineCapped && !byteCapped) {
    return { text: trimmed, lines, bytes, lineCapped, byteCapped }
  }

  const byLine = lineCapped
    ? trimmed.split(NEWLINE).slice(0, MAX_INDEX_LINES).join(NEWLINE)
    : trimmed

  const cutAt = byLine.lastIndexOf(NEWLINE, MAX_INDEX_BYTES)
  const kept =
    byLine.length > MAX_INDEX_BYTES ? byLine.slice(0, cutAt > 0 ? cutAt : MAX_INDEX_BYTES) : byLine

  const warning = `> Only part of this index was loaded: it is ${reasonFor({ lines, bytes, lineCapped, byteCapped })}. Keep each entry to one line under ~200 characters and move detail into the memory file it points at.`

  return { text: `${kept}\n\n${warning}`, lines, bytes, lineCapped, byteCapped }
}
