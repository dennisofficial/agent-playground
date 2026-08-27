import { mixHex } from './colour'
import type { Span } from './components/spans'

/**
 * Futura Bold "Atlas" rasterised to the terminal's half-cell grid: two pixel rows per text row,
 * each pixel one of five ink densities. Rendered as `▀` with an independent foreground and
 * background tint, which is what buys the vertical resolution a single shade glyph cannot.
 */
const MARK_PIXELS: readonly string[] = [
  '0000000000000000000000000002221000000000000000000000000000',
  '0000000000000000000000000014441000000000000000000000000000',
  '0000014444100000000000000014441000000000000000000000000000',
  '0000034444300000000111000014441000000000000000000000000000',
  '0000044444400000001444100014441000000000000000000000000000',
  '0000244444420000001444100014441000000000000000000000000000',
  '0000444444440000002444210014441000000122101111000000222100',
  '0001444324441000024444441014441000004444434443000024444440',
  '0003444114443000024444441014441000044444444443000144444420',
  '0004444004444000024444431014441000344443344443000244400100',
  '0014442002444200001444100014441000444400014443000244442000',
  '0034443223444400001444100014441000444300004443000044444420',
  '0044444444444400001444100014441000444300004443000013444440',
  '0244444444444420001444100014441000444410024443000000014442',
  '0444421111244440001444100014441000244444444443000242134441',
  '1444400000034441001444100014441000034444444443000444444440',
  '3444200000024443001444100014441000002444414443000244444300',
  '0000000000000000000000000000000000000011000000000001110000',
]

const DENSITY: readonly number[] = [0, 0.16, 0.4, 0.7, 1]

const CREST_LIFT = 0.22

const FOOT_FALL = 0.3

const HALF_CELL = '▀'

export const WORDMARK_CELLS = Math.max(...MARK_PIXELS.map((row) => row.length))

export const WORDMARK_ROWS = Math.ceil(MARK_PIXELS.length / 2)

function inkAt(args: { row: string; column: number }): number {
  return DENSITY[Number(args.row[args.column] ?? '0')] ?? 0
}

function tintAt(args: { crest: string; foot: string; pixelRow: number }): string {
  const span = MARK_PIXELS.length - 1
  if (span <= 0) return args.crest
  return mixHex({ from: args.crest, to: args.foot, amount: args.pixelRow / span })
}

function appendRun(args: { spans: Span[]; text: string; fg?: string; bg?: string }): void {
  const last = args.spans[args.spans.length - 1]
  if (last !== undefined && last.fg === args.fg && last.bg === args.bg) {
    args.spans[args.spans.length - 1] = { ...last, text: last.text + args.text }
    return
  }
  args.spans.push({
    text: args.text,
    ...(args.fg === undefined ? {} : { fg: args.fg }),
    ...(args.bg === undefined ? {} : { bg: args.bg }),
  })
}

function rowSpans(args: {
  top: string
  bottom: string
  topTint: string
  bottomTint: string
  ground: string
}): Span[] {
  const spans: Span[] = []
  for (let column = 0; column < WORDMARK_CELLS; column += 1) {
    const upper = inkAt({ row: args.top, column })
    const lower = inkAt({ row: args.bottom, column })
    if (upper === 0 && lower === 0) {
      appendRun({ spans, text: ' ' })
      continue
    }
    appendRun({
      spans,
      text: HALF_CELL,
      fg: mixHex({ from: args.ground, to: args.topTint, amount: upper }),
      bg: mixHex({ from: args.ground, to: args.bottomTint, amount: lower }),
    })
  }
  const last = spans[spans.length - 1]
  if (last !== undefined && last.fg === undefined && last.bg === undefined) spans.pop()
  return spans
}

export function wordmarkRows(args: { accent: string; ground: string; bright: string }): Span[][] {
  const crest = mixHex({ from: args.accent, to: args.bright, amount: CREST_LIFT })
  const foot = mixHex({ from: args.accent, to: args.ground, amount: FOOT_FALL })

  const rows: Span[][] = []
  for (let pixelRow = 0; pixelRow < MARK_PIXELS.length; pixelRow += 2) {
    rows.push(
      rowSpans({
        top: MARK_PIXELS[pixelRow] ?? '',
        bottom: MARK_PIXELS[pixelRow + 1] ?? '',
        topTint: tintAt({ crest, foot, pixelRow }),
        bottomTint: tintAt({ crest, foot, pixelRow: pixelRow + 1 }),
        ground: args.ground,
      }),
    )
  }
  return rows
}
