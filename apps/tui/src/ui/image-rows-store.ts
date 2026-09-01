export const SHIPPED_IMAGE_ROWS = 30

let tallest = SHIPPED_IMAGE_ROWS

export const imageRows = (): number => tallest

export function applyImageRows(rows: number): void {
  tallest = Math.max(1, Math.floor(rows))
}
