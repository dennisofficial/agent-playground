import { decodePasteBytes, stripAnsiSequences, type PasteEvent } from '@opentui/core'

/**
 * A terminal in bracketed-paste mode wraps the clipboard in ESC[200~ … ESC[201~, and OpenTUI's
 * stdin parser lifts that whole run out of the key stream into a paste event. A prompt that only
 * listens for keypresses therefore never sees a pasted code at all.
 */
export const pastedText = (event: PasteEvent): string =>
  pastedContent(event).replace(/[\r\n]/g, '').trim()

/**
 * The clipboard text with its line breaks still in it — the decision to tokenise a paste, and the
 * content that pasting tokenises, both want the text as it actually arrived.
 */
export const pastedContent = (event: PasteEvent): string =>
  stripAnsiSequences(decodePasteBytes(event.bytes))

/**
 * The clipboard held a picture. A terminal asked to paste one has nothing to send — macOS makes the
 * empty string of it — so the paste arrives with no text at all, and that emptiness is the only
 * signal there is that a picture is sitting there waiting to be pulled.
 */
export const isEmptyPaste = (event: PasteEvent): boolean => pastedText(event).length === 0
