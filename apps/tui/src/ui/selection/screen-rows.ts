import type { CliRenderer } from '@opentui/core'

const BLANK = ' '

const UNKNOWN = '\uFFFD'

const MAX_CODE_POINT = 0x10ffff

const cellText = (code: number): string => {
  if (code === 0) return BLANK
  if (code < 0 || code > MAX_CODE_POINT) return UNKNOWN
  return String.fromCodePoint(code)
}

export function screenRow(args: { renderer: CliRenderer; y: number }): string {
  const buffer = args.renderer.currentRenderBuffer
  if (args.y < 0 || args.y >= buffer.height) return ''

  const cells = buffer.buffers.char
  const row: string[] = []
  for (let x = 0; x < buffer.width; x += 1) {
    row.push(cellText(cells[args.y * buffer.width + x] ?? 0))
  }

  return row.join('')
}

export function firstInkedColumn(args: {
  renderer: CliRenderer
  y: number
  from: number
  to: number
}): number {
  const row = [...screenRow({ renderer: args.renderer, y: args.y })]
  for (let x = Math.max(0, args.from); x <= Math.min(args.to, row.length - 1); x += 1) {
    if ((row[x] ?? BLANK).trim() !== '') return x
  }
  return args.from
}

export function lastInkedColumn(args: {
  renderer: CliRenderer
  y: number
  from: number
  to: number
}): number {
  const row = [...screenRow({ renderer: args.renderer, y: args.y })]
  for (let x = Math.min(args.to, row.length - 1); x >= args.from; x -= 1) {
    if ((row[x] ?? BLANK).trim() !== '') return x
  }
  return args.from
}
