import { marked, type Token } from 'marked'

import {
  type Context,
  contextFor,
  type LiftedFootnotes,
  liftFootnotes,
  type SourcedBlock,
  sourcedFromTokens,
  sourcedProseBlocks,
  withFootnotes,
} from './blocks'

/**
 * marked 18 block tokens that end at a blank line whatever follows it. A list, an indented or
 * fenced block and an html block can reach past a blank line, so they are not here. A link
 * reference definition ANYWHERE — top level, inside a list item, inside a quote, with a label that
 * spans lines — rewires how `[text]` lexes everywhere (marked's lexer registers `tokens.links` from
 * nested children too), so any `]:` in the body forces a whole lex. marked normalises `\r\n` and
 * `\r` to `\n` before lexing, which makes token raws shorter than the source; a body carrying `\r`
 * takes the whole lex too. Table rows continue across a tab-only line (marked's row lookahead is
 * spaces-only), so only a spaces-only line counts as blank here.
 */

const SEALED_TYPES: ReadonlySet<string> = new Set([
  'space',
  'paragraph',
  'text',
  'heading',
  'hr',
  'blockquote',
  'table',
])

const LINK_DEFINITION_ANYWHERE = /\]:/

const CARRIAGE_RETURN = /\r/

const FOOTNOTE_DEFINITION_ANYWHERE = /^\[\^[^\]\s]+\]:/m

const BLANK_LINE_END = /\n *\n/g

const SETTLED_LIMIT = 8

const GROWN_LIMIT = 8

type SettledProse = {
  readonly body: string
  readonly labels: string
  readonly blocks: readonly SourcedBlock[]
}

const settledProse: SettledProse[] = []

const grownBySource = new Map<string, readonly SourcedBlock[]>()

const NO_FOOTNOTES: ReadonlyMap<string, string> = new Map()

export function proseBlocksFor(args: { source: string; streaming: boolean }): readonly SourcedBlock[] {
  if (args.streaming) return growingProseBlocks(args.source)
  return grownBySource.get(args.source) ?? sourcedProseBlocks(args.source)
}

export function growingProseBlocks(source: string): readonly SourcedBlock[] {
  const lifted: LiftedFootnotes = FOOTNOTE_DEFINITION_ANYWHERE.test(source)
    ? liftFootnotes(source)
    : { body: source, definitions: NO_FOOTNOTES }
  const context = contextFor(lifted)

  const wholeLex = LINK_DEFINITION_ANYWHERE.test(lifted.body) || CARRIAGE_RETURN.test(lifted.body)
  const sourced = wholeLex
    ? sourcedFromTokens({ tokens: marked.lexer(lifted.body), context })
    : grownBlocks({ body: lifted.body, context, labels: [...context.order.keys()].join('\n') })

  const blocks = withFootnotes({ sourced, lifted, context })
  rememberGrown({ source, blocks })
  return blocks
}

function grownBlocks(args: {
  body: string
  context: Context
  labels: string
}): readonly SourcedBlock[] {
  const base = settledFor(args) ?? rootSettled(args.labels)
  const settled = advanced({ base, rest: args.body.slice(base.body.length), context: args.context })
  const tail = args.body.slice(settled.body.length)
  if (tail.length === 0) return settled.blocks

  return [
    ...settled.blocks,
    ...sourcedFromTokens({ tokens: marked.lexer(tail), context: args.context }),
  ]
}

function settledFor(args: { body: string; labels: string }): SettledProse | undefined {
  let longest: SettledProse | undefined
  for (const entry of settledProse) {
    if (entry.labels !== args.labels || !args.body.startsWith(entry.body)) continue
    if (longest === undefined || entry.body.length > longest.body.length) longest = entry
  }
  return longest
}

function rootSettled(labels: string): SettledProse {
  const root: SettledProse = { body: '', labels, blocks: [] }
  settledProse.push(root)
  if (settledProse.length > SETTLED_LIMIT) settledProse.shift()
  return root
}

const unsealedCandidates = new WeakMap<SettledProse, string>()

function advanced(args: { base: SettledProse; rest: string; context: Context }): SettledProse {
  const cut = lastBlankLineEnd(args.rest)
  if (cut <= 0) return args.base

  const candidate = args.rest.slice(0, cut)
  if (unsealedCandidates.get(args.base) === candidate) return args.base

  const tokens = marked.lexer(candidate)
  const sealed = sealedTokens(tokens)
  if (sealed.length === 0) {
    unsealedCandidates.set(args.base, candidate)
    return args.base
  }

  const settled: SettledProse = {
    body: args.base.body + sealed.map((token) => token.raw).join(''),
    labels: args.base.labels,
    blocks: [...args.base.blocks, ...sourcedFromTokens({ tokens: sealed, context: args.context })],
  }
  rememberSettled({ settled, replacing: args.base })
  return settled
}

function lastBlankLineEnd(text: string): number {
  let end = 0
  for (const hit of text.matchAll(BLANK_LINE_END)) end = hit.index + hit[0].length
  return end
}

function sealedTokens(tokens: readonly Token[]): readonly Token[] {
  for (let end = tokens.length; end > 0; end -= 1) {
    const last = tokens[end - 1]
    if (last === undefined || !endsOnBlankLine(last.raw)) continue

    const anchor = lastBlockBefore({ tokens, end })
    if (anchor === -1) return tokens.slice(0, end)
    const block = tokens[anchor]
    if (block !== undefined && SEALED_TYPES.has(block.type)) return tokens.slice(0, end)
    end = anchor + 1
  }
  return []
}

function lastBlockBefore(args: { tokens: readonly Token[]; end: number }): number {
  for (let index = args.end - 1; index >= 0; index -= 1) {
    if (args.tokens[index]?.type !== 'space') return index
  }
  return -1
}

function endsOnBlankLine(raw: string): boolean {
  return /\n *\n *$/.test(raw) || /^ *\n *$/.test(raw)
}

function rememberSettled(args: { settled: SettledProse; replacing: SettledProse }): void {
  const index = settledProse.indexOf(args.replacing)
  if (index !== -1) settledProse.splice(index, 1)
  settledProse.push(args.settled)
  if (settledProse.length > SETTLED_LIMIT) settledProse.shift()
}

function rememberGrown(args: { source: string; blocks: readonly SourcedBlock[] }): void {
  if (grownBySource.size >= GROWN_LIMIT) {
    const oldest = grownBySource.keys().next()
    if (!oldest.done) grownBySource.delete(oldest.value)
  }
  grownBySource.set(args.source, args.blocks)
}
