import type { TextareaRenderable } from '@opentui/core'
import { imageTag, type ImageTagSpan } from '@dltech/atlas-core'

import type { ClipboardImage } from './clipboard-image'

/**
 * What a span of the draft carries once it has been tokenised. Attachments hang off the extmark
 * rather than off the text, so a label typed by hand is prose while a label the registry made is
 * live — that is the whole of the WYSIWYG rule.
 */
export type TokenSlot =
  | { kind: 'image'; ordinal: number; settled: boolean; image: ClipboardImage | null }
  | { kind: 'pasted'; label: string; content: string }

/** `ordinal` is a lie for pasted tokens, but the span helpers all speak one shape. */
export type LiveToken = ImageTagSpan & {
  id: number
  slot: TokenSlot
}

export const PASTE_TOKEN_LINES = 4

export const pastedLabel = (ordinal: number, lineCount: number): string =>
  `[Pasted text #${ordinal} +${lineCount} lines]`

export const tokenizablePaste = (content: string): boolean =>
  content.split('\n').length > PASTE_TOKEN_LINES

export function liveTokens(editor: TextareaRenderable): LiveToken[] {
  return editor.extmarks
    .getAll()
    .filter((mark) => mark.data !== undefined && isTokenSlot(mark.data))
    .sort((left, right) => left.start - right.start)
    .map((mark) => {
      const slot = mark.data as TokenSlot
      return {
        id: mark.id,
        start: mark.start,
        end: mark.end,
        ordinal: slot.kind === 'image' ? slot.ordinal : 0,
        slot,
      }
    })
}

function isTokenSlot(data: unknown): data is TokenSlot {
  return (
    typeof data === 'object' &&
    data !== null &&
    ((data as TokenSlot).kind === 'image' || (data as TokenSlot).kind === 'pasted')
  )
}

const nextOrdinal = (tokens: readonly LiveToken[]): number =>
  tokens.reduce((highest, token) => {
    if (token.slot.kind !== 'image') return highest
    return Math.max(highest, token.slot.ordinal)
  }, 0) + 1

/**
 * The label goes into the buffer synchronously, so a paste paints its token in the same frame the
 * clipboard read still runs. The extmark carries the slot, which is what submit later reads back.
 */
export function insertToken(args: {
  editor: TextareaRenderable
  label: string
  slot: TokenSlot
}): LiveToken {
  const start = args.editor.cursorOffset
  args.editor.insertText(`${args.label} `)
  const id = args.editor.extmarks.create({
    start,
    end: start + args.label.length,
    virtual: true,
    data: args.slot,
  })
  const ordinal = args.slot.kind === 'image' ? args.slot.ordinal : 0
  return { id, start, end: start + args.label.length, ordinal, slot: args.slot }
}

export function insertImagePlaceholder(editor: TextareaRenderable): LiveToken {
  const ordinal = nextOrdinal(liveTokens(editor))
  const slot: TokenSlot = { kind: 'image', ordinal, settled: false, image: null }
  return insertToken({ editor, label: imageTag(ordinal), slot })
}

export function insertPastedToken(args: {
  editor: TextareaRenderable
  content: string
}): LiveToken {
  const ordinal = liveTokens(args.editor).filter((t) => t.slot.kind === 'pasted').length + 1
  const slot: TokenSlot = {
    kind: 'pasted',
    label: pastedLabel(ordinal, args.content.split('\n').length),
    content: args.content,
  }
  return insertToken({ editor: args.editor, label: slot.label, slot })
}

/**
 * A clipboard read that came back empty leaves a lying label behind; the whole span is cut through
 * the editor's own deletion path, which keeps the extmark bookkeeping honest.
 */
export function removeToken(editor: TextareaRenderable, token: LiveToken): void {
  editor.setSelection(token.start, token.end)
  editor.deleteSelection()
}

/** Text after every pasted-token label is swapped back for the content it stands for. */
export function substitutePastedTokens(args: {
  text: string
  tokens: readonly LiveToken[]
}): string {
  let text = args.text
  for (const token of [...args.tokens].sort((a, b) => b.start - a.start)) {
    if (token.slot.kind !== 'pasted') continue
    text = text.slice(0, token.start) + token.slot.content + text.slice(token.end)
  }
  return text
}

export function tokenAtOffset(args: { editor: TextareaRenderable; offset: number }): LiveToken | null {
  const tokens = liveTokens(args.editor)
  return tokens.find((token) => token.start < args.offset && args.offset < token.end) ?? null
}


