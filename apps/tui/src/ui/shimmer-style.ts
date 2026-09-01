import { mixHex } from './colour'
import type { Span } from './components/spans'
import { shimmerHeat, type ShimmerSpec } from './shimmer'
import { theme } from './theme'

export const SHIMMER_CREST = '#f6efe9'

export function shimmerColour(heat: number, base?: string): string {
  return mixHex({ from: base ?? theme.accent, to: SHIMMER_CREST, amount: heat })
}

export function shimmerSpans(args: {
  text: string
  crest: number
  spec: ShimmerSpec
  offset?: number
  base?: string
}): Span[] {
  const offset = args.offset ?? 0
  const spans: Span[] = []

  for (const [index, character] of [...args.text].entries()) {
    const heat = shimmerHeat({ index: index + offset, crest: args.crest, spec: args.spec })
    const fg = shimmerColour(heat, args.base)
    const last = spans[spans.length - 1]
    if (last && last.fg === fg) {
      last.text += character
      continue
    }
    spans.push({ text: character, fg })
  }
  return spans
}
