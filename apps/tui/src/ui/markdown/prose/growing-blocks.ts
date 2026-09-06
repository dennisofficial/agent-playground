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
 * marked's block tokens tile their input, and most of them end at a blank line no matter what
 * follows it: a paragraph, heading, rule, quote or table lexes the same whether the message stops
 * there or goes on. Only a list, an indented or fenced block, and an html block can reach past a
 * blank line to swallow what comes after — and a link reference definition anywhere changes how
 * `[text]` lexes everywhere, as a footnote definition does for `[^label]`.
 *
 * So a streamed prose body is settled up to the last blank line that follows a sealed token, the
 * blocks for that prefix are kept by its text, and each republish lexes only the tail behind it.
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

const LINK_DEFINITION_ANYWHERE = /^[ \t>]*\[[^\n]*\]:/m

const FOOTNOTE_DEFINITION_ANYWHERE = /^\[\^[^\]\s]+\]:/m

const BLANK_LINE_END = /\n[ \t]*\n/g

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

  const sourced = LINK_DEFINITION_ANYWHERE.test(lifted.body)
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

/**
 * A list that is still growing holds every blank line inside it, so the same candidate fails to
 * seal on every republish until the list ends. Remembering the failure keeps that at one lex of
 * the candidate per new blank line rather than one per chunk.
 */
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

/**
 * The longest token prefix that ends on a blank line and whose last block is sealed. The blank line
 * is either a `space` token or the trailing newlines a heading, rule or table swallows into its own
 * raw, so the check is on the last token that is not `space` — a list followed by a `space` is
 * still a list that the next bullet would extend.
 */
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
  return /\n[ \t]*\n[ \t]*$/.test(raw) || /^[ \t]*\n[ \t]*$/.test(raw)
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
