import { EMPTY_YAML_MAP, type YamlMap, type YamlValue } from './value'
import { scalarOf, splitOutsideGroups, unquoted } from './scalar'

const FENCE = '---'
const LIST_MARKER = '-'
const BLOCK_MARKER = /^([|>])([-+]?)\d*$/

enum EChomp {
  Clip = 'clip',
  Strip = 'strip',
  Keep = 'keep',
}

type BlockStyle = { folded: boolean; chomp: EChomp }

type Reader = { lines: readonly string[]; at: number }

const indentOf = (line: string): number => line.length - line.trimStart().length

const isSkippable = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

const isListItem = (trimmed: string): boolean =>
  trimmed === LIST_MARKER || trimmed.startsWith(`${LIST_MARKER} `)

const contentAt = (reader: Reader): number => {
  let at = reader.at
  while (at < reader.lines.length && isSkippable(reader.lines[at] ?? '')) at += 1
  return at
}

const chompOf = (written: string): EChomp => {
  if (written === '-') return EChomp.Strip
  if (written === '+') return EChomp.Keep
  return EChomp.Clip
}

const blockStyleOf = (marker: string): BlockStyle | undefined => {
  const match = BLOCK_MARKER.exec(marker)
  if (match === null) return undefined
  return { folded: match[1] === '>', chomp: chompOf(match[2] ?? '') }
}

const chomped = (args: { body: string; chomp: EChomp }): string => {
  if (args.chomp === EChomp.Keep) return args.body

  const stripped = args.body.replace(/\n+$/, '')
  if (args.chomp === EChomp.Strip || stripped === '') return stripped
  return `${stripped}\n`
}

const foldedBody = (lines: readonly string[]): string => {
  const paragraphs: string[][] = [[]]

  for (const line of lines) {
    if (line.trim() === '') {
      paragraphs.push([])
      continue
    }
    paragraphs[paragraphs.length - 1]?.push(line.trim())
  }

  return paragraphs.map((paragraph) => paragraph.join(' ')).join('\n')
}

const blockScalar = (args: { reader: Reader; indent: number; style: BlockStyle }): string => {
  const collected: string[] = []
  let contentIndent: number | undefined

  while (args.reader.at < args.reader.lines.length) {
    const line = args.reader.lines[args.reader.at] ?? ''
    if (line.trim() === '') {
      collected.push('')
      args.reader.at += 1
      continue
    }

    const indent = indentOf(line)
    if (indent <= args.indent) break
    if (contentIndent === undefined) contentIndent = indent

    collected.push(line.slice(Math.min(contentIndent, indent)))
    args.reader.at += 1
  }

  const body = args.style.folded ? foldedBody(collected) : collected.join('\n')
  return chomped({ body, chomp: args.style.chomp })
}

const flowList = (marker: string): readonly YamlValue[] => {
  const closing = marker.lastIndexOf(']')
  const inner = closing === -1 ? marker.slice(1) : marker.slice(1, closing)

  return splitOutsideGroups({ text: inner, isSeparator: (character) => character === ',' }).map(
    unquoted,
  )
}

const parseMapAt = (reader: Reader, indent: number): YamlMap => {
  const entries = new Map<string, YamlValue>()

  while (true) {
    const at = contentAt(reader)
    reader.at = at
    if (at >= reader.lines.length) return entries

    const line = reader.lines[at] ?? ''
    const lineIndent = indentOf(line)
    if (lineIndent < indent) return entries

    reader.at = at + 1
    if (lineIndent > indent) continue

    const trimmed = line.trim()
    if (isListItem(trimmed)) continue

    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue

    const key = trimmed.slice(0, colon).trim()
    if (key === '') continue

    entries.set(key, valueOf({ reader, rest: trimmed.slice(colon + 1), indent: lineIndent }))
  }
}

const parseListAt = (reader: Reader, indent: number): readonly YamlValue[] => {
  const items: YamlValue[] = []

  while (true) {
    const at = contentAt(reader)
    reader.at = at
    if (at >= reader.lines.length) return items

    const line = reader.lines[at] ?? ''
    const trimmed = line.trim()
    if (indentOf(line) !== indent || !isListItem(trimmed)) return items

    reader.at = at + 1
    const rest = trimmed.slice(LIST_MARKER.length)
    const marker = rest.trim()

    if (marker === '') {
      items.push(nestedOf({ reader, indent }))
      continue
    }
    if (marker.startsWith('[')) {
      items.push(flowList(marker))
      continue
    }
    items.push(scalarOf(rest))
  }
}

function nestedOf(args: { reader: Reader; indent: number }): YamlValue {
  const at = contentAt(args.reader)
  args.reader.at = at
  if (at >= args.reader.lines.length) return ''

  const line = args.reader.lines[at] ?? ''
  const childIndent = indentOf(line)
  const trimmed = line.trim()

  if (isListItem(trimmed) && childIndent >= args.indent)
    return parseListAt(args.reader, childIndent)
  if (childIndent > args.indent) return parseMapAt(args.reader, childIndent)
  return ''
}

function valueOf(args: { reader: Reader; rest: string; indent: number }): YamlValue {
  const marker = args.rest.trim()

  const style = blockStyleOf(marker)
  if (style !== undefined) return blockScalar({ reader: args.reader, indent: args.indent, style })
  if (marker.startsWith('[')) return flowList(marker)
  if (marker !== '' && !marker.startsWith('#')) return scalarOf(args.rest)

  return nestedOf({ reader: args.reader, indent: args.indent })
}

export function parseYaml(text: string): YamlMap {
  const reader: Reader = { lines: text.split('\n'), at: 0 }
  const at = contentAt(reader)
  if (at >= reader.lines.length) return EMPTY_YAML_MAP

  reader.at = at
  return parseMapAt(reader, indentOf(reader.lines[at] ?? ''))
}

export function parseFrontmatter(text: string): { document: YamlMap; body: string } {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== FENCE) return { document: EMPTY_YAML_MAP, body: text }

  const closing = lines.findIndex((line, at) => at > 0 && line.trim() === FENCE)
  if (closing === -1) return { document: EMPTY_YAML_MAP, body: text }

  return {
    document: parseYaml(lines.slice(1, closing).join('\n')),
    body: lines
      .slice(closing + 1)
      .join('\n')
      .replace(/^\n+/, ''),
  }
}
