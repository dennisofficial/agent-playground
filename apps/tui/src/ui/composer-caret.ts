export type CaretReading = { text: string; offset: number; rowEndOffset: number | null }

/**
 * `rowEndOffset` is `editorView.getVisualEOL().offset` — the end of the caret's own *visual* row,
 * absolute in the document even when the viewport has scrolled (only `VisualCursor.visualRow` is
 * viewport-relative). A soft-wrapped paragraph therefore reads as several rows, so Down inside one
 * still moves the caret rather than leaving the composer. `null` means nothing measured it, and
 * the logical line is the honest reading left.
 */
export function caretOnLastRow(caret: CaretReading): boolean {
  if (caret.rowEndOffset !== null) return caret.rowEndOffset >= caret.text.length
  return !caret.text.slice(caret.offset).includes('\n')
}
