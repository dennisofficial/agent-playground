export type WordSpan = { readonly start: number; readonly end: number }

enum ECellClass {
  Word = 'word',
  Space = 'space',
  Mark = 'mark',
}

const WORD_CELL = /[\p{L}\p{N}_-]/u

const classOf = (cell: string): ECellClass => {
  if (cell.trim() === '') return ECellClass.Space
  return WORD_CELL.test(cell) ? ECellClass.Word : ECellClass.Mark
}

export function wordSpanAt(args: { row: string; column: number }): WordSpan | null {
  const cells = [...args.row]
  const at = cells[args.column]
  if (at === undefined) return null

  const kind = classOf(at)
  if (kind === ECellClass.Space) return null

  let start = args.column
  while (start > 0 && classOf(cells[start - 1] ?? ' ') === kind) start -= 1

  let end = args.column + 1
  while (end < cells.length && classOf(cells[end] ?? ' ') === kind) end += 1

  return { start, end }
}
