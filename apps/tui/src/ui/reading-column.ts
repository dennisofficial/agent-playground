export const READING_COLUMN = 88

const NARROWEST_COLUMN = 20

export function readingColumn(terminalWidth: number): number {
  return Math.max(NARROWEST_COLUMN, Math.min(READING_COLUMN, terminalWidth))
}
