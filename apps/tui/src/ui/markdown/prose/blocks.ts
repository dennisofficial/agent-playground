import { marked, type Token, type Tokens } from 'marked'

import { EInline, type InlineNode, inlineNodes } from './inline'
import { superscriptNumber } from './unicode'

export enum EProseBlock {
  Heading = 'heading',
  Paragraph = 'paragraph',
  List = 'list',
  Quote = 'quote',
  Rule = 'rule',
  Definitions = 'definitions',
  Footnotes = 'footnotes',
  Code = 'code',
  Table = 'table',
}

export type ListItem = {
  readonly content: readonly InlineNode[]
  readonly checked: boolean | null
  readonly children: readonly ProseBlock[]
}

export type Footnote = {
  readonly marker: string
  readonly content: readonly InlineNode[]
}

export type ProseBlock =
  | {
      readonly kind: EProseBlock.Heading
      readonly level: number
      readonly content: readonly InlineNode[]
    }
  | {
      readonly kind: EProseBlock.Paragraph
      readonly content: readonly InlineNode[]
    }
  | {
      readonly kind: EProseBlock.List
      readonly ordered: boolean
      readonly start: number
      readonly items: readonly ListItem[]
    }
  | {
      readonly kind: EProseBlock.Quote
      readonly children: readonly ProseBlock[]
    }
  | { readonly kind: EProseBlock.Rule }
  | {
      readonly kind: EProseBlock.Definitions
      readonly term: readonly InlineNode[]
      readonly definitions: readonly (readonly InlineNode[])[]
    }
  | {
      readonly kind: EProseBlock.Footnotes
      readonly notes: readonly Footnote[]
    }
  | {
      readonly kind: EProseBlock.Code
      readonly language: string
      readonly source: string
    }
  | { readonly kind: EProseBlock.Table; readonly markdown: string }

const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/
const DEFINITION_LINE = /^:[ \t]+(.*)$/

type Context = { readonly order: ReadonlyMap<string, number> }

export type SourcedBlock = { readonly block: ProseBlock; readonly raw: string }

export function proseBlocks(source: string): readonly ProseBlock[] {
  return sourcedProseBlocks(source).map((sourced) => sourced.block)
}

export function sourcedProseBlocks(source: string): readonly SourcedBlock[] {
  const { body, definitions } = liftFootnotes(source)
  const order = new Map([...definitions.keys()].map((label, index) => [label, index + 1]))
  const context: Context = { order }

  const sourced = marked
    .lexer(body)
    .flatMap((token) => blockOf({ token, context }).map((block) => ({ block, raw: token.raw })))
  if (definitions.size === 0) return sourced

  const notes = [...definitions].map(([label, text]) => ({
    marker: superscriptNumber(order.get(label) ?? 0),
    content: inlineNodes({ tokens: marked.lexer(text), order }),
  }))
  return [...sourced, { block: { kind: EProseBlock.Footnotes, notes }, raw: '' }]
}

function liftFootnotes(source: string): {
  body: string
  definitions: Map<string, string>
} {
  const definitions = new Map<string, string>()
  const kept: string[] = []
  let open: string | null = null

  for (const line of source.split('\n')) {
    const opened = FOOTNOTE_DEFINITION.exec(line)
    if (opened !== null) {
      open = opened[1] ?? ''
      definitions.set(open, opened[2] ?? '')
      continue
    }
    if (open !== null && /^\s+\S/.test(line)) {
      definitions.set(open, `${definitions.get(open) ?? ''} ${line.trim()}`)
      continue
    }
    open = null
    kept.push(line)
  }

  return { body: kept.join('\n'), definitions }
}

function blocksOf(args: { tokens: readonly Token[]; context: Context }): readonly ProseBlock[] {
  return args.tokens.flatMap((token) => blockOf({ token, context: args.context }))
}

function blockOf(args: { token: Token; context: Context }): readonly ProseBlock[] {
  const { token, context } = args
  const order = context.order

  if (token.type === 'space') return []
  if (token.type === 'hr') return [{ kind: EProseBlock.Rule }]

  if (token.type === 'heading') {
    const heading = token as Tokens.Heading
    return [
      {
        kind: EProseBlock.Heading,
        level: heading.depth,
        content: inlineNodes({ tokens: heading.tokens, order }),
      },
    ]
  }

  if (token.type === 'code') {
    const code = token as Tokens.Code
    return [
      {
        kind: EProseBlock.Code,
        language: code.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '',
        source: code.text.replace(/\n$/, ''),
      },
    ]
  }

  if (token.type === 'table') return [{ kind: EProseBlock.Table, markdown: token.raw }]

  if (token.type === 'blockquote') {
    const quote = token as Tokens.Blockquote
    return [
      {
        kind: EProseBlock.Quote,
        children: blocksOf({ tokens: quote.tokens, context }),
      },
    ]
  }

  if (token.type === 'list') return [listBlock({ token: token as Tokens.List, context })]

  if (token.type === 'paragraph' || token.type === 'text' || token.type === 'html') {
    return paragraphBlocks({ token, context })
  }

  return []
}

function listBlock(args: { token: Tokens.List; context: Context }): ProseBlock {
  return {
    kind: EProseBlock.List,
    ordered: args.token.ordered,
    start: typeof args.token.start === 'number' ? args.token.start : 1,
    items: args.token.items.map((item) => listItem({ item, context: args.context })),
  }
}

const LEAD_TOKENS = new Set(['text', 'paragraph'])

const TASK_MARKER = /^\[[ xX]\]\s+/

function listItem(args: { item: Tokens.ListItem; context: Context }): ListItem {
  const tokens = args.item.tokens.filter((token) => token.type !== 'checkbox')
  const first = tokens[0]
  const lead = first !== undefined && LEAD_TOKENS.has(first.type) ? first : undefined
  const rest = tokens.slice(lead === undefined ? 0 : 1)

  const content =
    lead === undefined
      ? []
      : inlineNodes({
          tokens: 'tokens' in lead ? (lead.tokens ?? [lead]) : [lead],
          order: args.context.order,
        })

  return {
    content: args.item.task === true ? withoutTaskMarker(content) : content,
    checked: args.item.task === true ? args.item.checked === true : null,
    children: blocksOf({ tokens: rest, context: args.context }),
  }
}

/**
 * marked strips `[x] ` into its own `checkbox` token for a tight list, but folds it back into the
 * first token's text for a loose one. https://github.com/markedjs/marked/blob/master/src/Lexer.ts
 */
function withoutTaskMarker(content: readonly InlineNode[]): readonly InlineNode[] {
  const first = content[0]
  if (first === undefined || first.kind !== EInline.Text) return content
  const text = first.text.replace(TASK_MARKER, '')
  return text === first.text ? content : [{ ...first, text }, ...content.slice(1)]
}

function paragraphBlocks(args: { token: Token; context: Context }): readonly ProseBlock[] {
  const raw = 'text' in args.token ? String(args.token.text) : args.token.raw
  const definitions = definitionList({ raw, context: args.context })
  if (definitions !== null) return [definitions]

  const tokens =
    'tokens' in args.token && Array.isArray(args.token.tokens) && args.token.tokens.length > 0
      ? args.token.tokens
      : [args.token]
  const content = inlineNodes({ tokens, order: args.context.order })
  return content.length === 0 ? [] : [{ kind: EProseBlock.Paragraph, content }]
}

function definitionList(args: { raw: string; context: Context }): ProseBlock | null {
  const lines = args.raw.split('\n')
  if (lines.length < 2) return null

  const bodies = lines.slice(1).map((line) => DEFINITION_LINE.exec(line)?.[1])
  if (bodies.some((body) => body === undefined)) return null

  const inline = (text: string): readonly InlineNode[] =>
    inlineNodes({ tokens: marked.lexer(text), order: args.context.order })

  return {
    kind: EProseBlock.Definitions,
    term: inline(lines[0] ?? ''),
    definitions: bodies.map((body) => inline(body ?? '')),
  }
}
