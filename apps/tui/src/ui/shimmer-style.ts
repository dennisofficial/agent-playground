import type { Span } from './components/spans'
import { shimmerHeat, type ShimmerSpec } from './shimmer'
import { theme } from './theme'

export const SHIMMER_REST = '#9c948c'

export const SHIMMER_CREST = '#ffd9c4'

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

export function mixHex(from: string, to: string, amount: number): string {
  const t = Math.max(0, Math.min(1, amount))
  const [fromRed, fromGreen, fromBlue] = channels(from)
  const [toRed, toGreen, toBlue] = channels(to)
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(fromRed, toRed)}${channel(fromGreen, toGreen)}${channel(fromBlue, toBlue)}`
}

const CREST_SHOULDER = 0.6

export function shimmerColour(heat: number): string {
  if (heat > CREST_SHOULDER) {
    return mixHex(theme.accent, SHIMMER_CREST, (heat - CREST_SHOULDER) / (1 - CREST_SHOULDER))
  }
  return mixHex(SHIMMER_REST, theme.accent, heat / CREST_SHOULDER)
}

export function beaconColour(heat: number): string {
  return mixHex(theme.accent, SHIMMER_CREST, heat)
}

export function shimmerSpans(
  text: string,
  crest: number,
  spec: ShimmerSpec,
  offset = 0,
): Span[] {
  const spans: Span[] = []

  for (const [index, character] of [...text].entries()) {
    const fg = shimmerColour(shimmerHeat(index + offset, crest, spec))
    const last = spans[spans.length - 1]
    if (last && last.fg === fg) {
      last.text += character
      continue
    }
    spans.push({ text: character, fg })
  }
  return spans
}
