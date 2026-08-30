export type PeekCandidate = {
  key: string
  top: number
}

export function peekAbove(args: {
  candidates: readonly PeekCandidate[]
  viewportTop: number
}): string | null {
  let above: string | null = null

  for (const candidate of args.candidates) {
    if (candidate.top >= args.viewportTop) break
    above = candidate.key
  }

  return above
}

export function firstLineOf(text: string): string {
  for (const line of text.split('\n')) {
    const collapsed = line.trim().replace(/\s+/g, ' ')
    if (collapsed.length > 0) return collapsed
  }

  return ''
}
