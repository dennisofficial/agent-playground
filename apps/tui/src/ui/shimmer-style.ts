import { mixHex } from './colour'
import type { Span } from './components/spans'
import { shimmerHeat, type ShimmerSpec } from './shimmer'
import { theme } from './theme'

export const SHIMMER_REST = '#9c948c'

export const SHIMMER_CREST = '#ffd9c4'

const CREST_SHOULDER = 0.6

export function shimmerColour(heat: number): string {
  if (heat > CREST_SHOULDER) {
    return mixHex({
      from: theme.accent,
      to: SHIMMER_CREST,
      amount: (heat - CREST_SHOULDER) / (1 - CREST_SHOULDER),
    })
  }
  return mixHex({ from: SHIMMER_REST, to: theme.accent, amount: heat / CREST_SHOULDER })
}

export function beaconColour(heat: number): string {
  return mixHex({ from: theme.accent, to: SHIMMER_CREST, amount: heat })
}

export function shimmerSpans(args: {
  text: string
  crest: number
  spec: ShimmerSpec
  offset?: number
}): Span[] {
  const offset = args.offset ?? 0
  const spans: Span[] = []

  for (const [index, character] of [...args.text].entries()) {
    const heat = shimmerHeat({ index: index + offset, crest: args.crest, spec: args.spec })
    const fg = shimmerColour(heat)
    const last = spans[spans.length - 1]
    if (last && last.fg === fg) {
      last.text += character
      continue
    }
    spans.push({ text: character, fg })
  }
  return spans
}
