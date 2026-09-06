import { marked, type Tokens } from 'marked'

export enum EFenceState {
  Naming = 'naming',
  Writing = 'writing',
  Resting = 'resting',
  Closed = 'closed',
}

export type MarkdownSegment =
  | { readonly kind: 'prose'; readonly text: string }
  | {
      readonly kind: 'fence'
      readonly language: string
      readonly filename: string
      readonly source: string
      readonly raw: string
      readonly state: EFenceState
    }
  | { readonly kind: 'table'; readonly markdown: string }

export function segmentMarkdown(source: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let prose = ''

  for (const token of marked.lexer(source)) {
    if (token.type === 'table') {
      if (prose) {
        segments.push({ kind: 'prose', text: prose })
        prose = ''
      }
      segments.push({ kind: 'table', markdown: token.raw })
      continue
    }

    if (token.type === 'code') {
      if (prose) {
        segments.push({ kind: 'prose', text: prose })
        prose = ''
      }
      segments.push(fenceSegment(token as Tokens.Code))
    } else {
      prose += token.raw
    }
  }
  if (prose) segments.push({ kind: 'prose', text: prose })

  return segments
}

const SETTLED_CACHE_LIMIT = 8

const settledCache = new Map<string, readonly MarkdownSegment[]>()

/**
 * marked's tokens tile their input, and only a fence can span a blank line — so everything before
 * the last blank line outside a fence lexes the same whether it stands alone or has more message
 * after it. Streamed growth re-lexes only the tail; the settled prefix is cached by its own text.
 */
export function growingSegments(args: { source: string }): readonly MarkdownSegment[] {
  const scan = scanBoundaries(args.source)
  if (scan.openFenceAt !== null) {
    return joinSeam({
      settled: scan.boundary === 0 ? [] : settledSegments(args.source.slice(0, scan.boundary)),
      live: [
        ...(scan.boundary === scan.openFenceAt
          ? []
          : segmentMarkdown(args.source.slice(scan.boundary, scan.openFenceAt))),
        openFenceSegment(args.source.slice(scan.openFenceAt)),
      ],
    })
  }
  if (scan.boundary === 0) return segmentMarkdown(args.source)

  return joinSeam({
    settled: settledSegments(args.source.slice(0, scan.boundary)),
    live: segmentMarkdown(args.source.slice(scan.boundary)),
  })
}

/**
 * marked's fence rule consumes to end of input when no closer arrives, so a tail that is one
 * unclosed fence is a single token by construction — building it directly skips the block
 * tokenizer's paragraph regexes over the whole fence body on every streamed chunk.
 */
function openFenceSegment(raw: string): MarkdownSegment {
  const lineEnd = raw.indexOf('\n')
  const openerLine = lineEnd === -1 ? raw : raw.slice(0, lineEnd)
  const marker = FENCE_OPENER.exec(openerLine)?.[1] ?? ''
  const info = openerLine
    .slice(openerLine.indexOf(marker) + marker.length)
    .trim()
    .split(/\s+/)

  return {
    kind: 'fence',
    language: info[0]?.toLowerCase() ?? '',
    filename: info[1] ?? '',
    // marked drops one trailing newline from an unclosed fence's text and fenceSegment drops
    // another, so the hand-built segment drops both to match.
    source: (lineEnd === -1 ? '' : raw.slice(lineEnd + 1)).replace(/\n{1,2}$/, ''),
    raw,
    state: fenceState(raw),
  }
}

function settledSegments(prefix: string): readonly MarkdownSegment[] {
  const hit = settledCache.get(prefix)
  if (hit !== undefined) return hit

  const segments = segmentMarkdown(prefix)
  if (settledCache.size >= SETTLED_CACHE_LIMIT) settledCache.clear()
  settledCache.set(prefix, segments)
  return segments
}

function joinSeam(args: {
  settled: readonly MarkdownSegment[]
  live: readonly MarkdownSegment[]
}): readonly MarkdownSegment[] {
  const last = args.settled.at(-1)
  const first = args.live[0]
  if (last === undefined || last.kind !== 'prose' || first === undefined || first.kind !== 'prose') {
    return [...args.settled, ...args.live]
  }
  return [
    ...args.settled.slice(0, -1),
    { kind: 'prose', text: last.text + first.text },
    ...args.live.slice(1),
  ]
}

function scanBoundaries(source: string): { boundary: number; openFenceAt: number | null } {
  let boundary = 0
  let open: string | null = null
  let openFenceAt: number | null = null
  let offset = 0

  const lines = source.split('\n')
  for (const line of lines.slice(0, -1)) {
    const lineStart = offset
    offset += line.length + 1

    const marker = FENCE_OPENER.exec(line)?.[1]
    if (marker !== undefined) {
      if (open === null) {
        open = marker
        openFenceAt = lineStart
      } else if (
        marker.charAt(0) === open.charAt(0) &&
        marker.length >= open.length &&
        line.trim() === marker
      ) {
        open = null
        openFenceAt = null
      }
      continue
    }

    if (open === null && line.trim().length === 0) boundary = offset
  }

  // The scan never examines the last line (it cannot settle a boundary), but the last line can
  // close the fence — and then the tail is not one unclosed token and marked must lex it.
  if (open !== null) {
    const lastLine = lines.at(-1) ?? ''
    const marker = FENCE_OPENER.exec(lastLine)?.[1]
    if (
      marker !== undefined &&
      marker.charAt(0) === open.charAt(0) &&
      marker.length >= open.length &&
      lastLine.trim() === marker
    ) {
      return { boundary, openFenceAt: null }
    }
  }

  return { boundary, openFenceAt }
}

/**
 * A fence that is still arriving changes shape under the renderer: its info string types out one
 * character at a time, so the language reads `t` then `ts`, and its last line is a fragment that
 * parses differently from the line it becomes. Both make the highlighter throw away a good answer
 * for a worse one. Hold the unsettled part back and it never renders at all.
 */
export function steadySegments(args: {
  segments: readonly MarkdownSegment[]
}): readonly MarkdownSegment[] {
  const last = args.segments.at(-1)
  if (last === undefined || last.kind !== 'fence' || last.state === EFenceState.Closed) {
    return args.segments
  }

  const settled = args.segments.slice(0, -1)
  if (last.state === EFenceState.Naming) return settled

  const body = last.state === EFenceState.Resting ? last.source : wholeLinesOf(last.source)
  return body.length === 0 ? settled : [...settled, steadiedFence({ last, body })]
}

type FenceSegment = Extract<MarkdownSegment, { kind: 'fence' }>

const STEADIED_LIMIT = 4

const steadiedFences = new Map<string, FenceSegment>()

/**
 * The whole-line body of an open fence changes only when a newline lands, so between newlines every
 * republish would otherwise mint a fresh segment for the same drawn block — and everything keyed on
 * the segment's identity downstream would miss. The raw and state are those of the first sighting;
 * nothing past this point reads the state, and the raw lags by at most the undrawn partial line.
 */
function steadiedFence(args: { last: FenceSegment; body: string }): FenceSegment {
  const key = `${args.last.language}\0${args.last.filename}\0${args.body}`
  const hit = steadiedFences.get(key)
  if (hit !== undefined) return hit

  const steadied: FenceSegment = { ...args.last, source: args.body }
  if (steadiedFences.size >= STEADIED_LIMIT) {
    const oldest = steadiedFences.keys().next()
    if (!oldest.done) steadiedFences.delete(oldest.value)
  }
  steadiedFences.set(key, steadied)
  return steadied
}

function wholeLinesOf(source: string): string {
  const lastLineBreak = source.lastIndexOf('\n')
  return lastLineBreak <= 0 ? '' : source.slice(0, lastLineBreak)
}

const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/

function fenceSegment(token: Tokens.Code): MarkdownSegment {
  const info = token.lang?.trim().split(/\s+/) ?? []
  return {
    kind: 'fence',
    language: info[0]?.toLowerCase() ?? '',
    filename: info[1] ?? '',
    // marked leaves a trailing newline on 4-space-indented blocks but not on backtick fences.
    source: token.text.replace(/\n$/, ''),
    raw: token.raw,
    state: fenceState(token.raw),
  }
}

function fenceState(raw: string): EFenceState {
  const opener = FENCE_OPENER.exec(raw)?.[1]
  if (opener === undefined) return EFenceState.Closed
  if (!raw.includes('\n')) return EFenceState.Naming

  const lines = raw.trimEnd().split('\n')
  const closer = lines.length > 1 ? (lines[lines.length - 1]?.trim() ?? '') : ''
  const isClosingFence =
    closer.length >= opener.length && closer === opener.charAt(0).repeat(closer.length)

  if (isClosingFence) return EFenceState.Closed

  return raw.endsWith('\n') ? EFenceState.Resting : EFenceState.Writing
}
