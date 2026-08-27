const CIRCULAR = '[circular]'

const unserialisableLine = (reason: string): string =>
  JSON.stringify({ atlasRawTape: 'unserialisable', reason })

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'could not be serialised'

function defensiveReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()

  return function replace(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value !== 'object' || value === null) return value
    if (seen.has(value)) return CIRCULAR
    seen.add(value)
    return value
  }
}

function defensiveLine(part: unknown): string {
  try {
    const defensive = JSON.stringify(part, defensiveReplacer())
    return defensive ?? unserialisableLine('serialised to nothing')
  } catch (error) {
    return unserialisableLine(messageOf(error))
  }
}

export function toTapeLine(part: unknown): string {
  try {
    const verbatim = JSON.stringify(part)
    if (verbatim !== undefined) return verbatim
  } catch {
    return defensiveLine(part)
  }

  return defensiveLine(part)
}

export const rotatedLine = (next: string): string =>
  JSON.stringify({ atlasRawTape: 'rotated', next })

export const closedLine = (): string => JSON.stringify({ atlasRawTape: 'closed' })
