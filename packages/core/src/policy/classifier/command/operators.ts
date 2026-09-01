const digit = /^[0-9]$/
const descriptorRedirects = ['2>>', '1>>', '2>', '1>']
const operators = [
  '&>>',
  '<<-',
  '&&',
  '||',
  ';;',
  '<<',
  '>>',
  '&>',
  '>|',
  '|&',
  '>&',
  ';',
  '|',
  '&',
  '(',
  ')',
  '<',
  '>',
  '\n',
]
const delimiterStops = ' \t\n;&|<>()'

export type OperatorMatch = {
  text: string
  next: number
}

export type HeredocDelimiter = {
  delimiter: string
  expands: boolean
  next: number
}

export function matchOperator(args: {
  source: string
  at: number
  midWord: boolean
}): OperatorMatch | undefined {
  const { source, at, midWord } = args
  const candidates = midWord ? operators : [...descriptorRedirects, ...operators]

  for (const candidate of candidates) {
    if (!source.startsWith(candidate, at)) continue

    let text = candidate
    let next = at + candidate.length
    const following = source[next]
    const afterFollowing = source[next + 1]

    if (
      text.endsWith('>') &&
      following === '&' &&
      afterFollowing !== undefined &&
      digit.test(afterFollowing)
    ) {
      text += `&${afterFollowing}`
      next += 2
    } else if (text.endsWith('&') && following !== undefined && digit.test(following)) {
      text += following
      next += 1
    }

    return { text, next }
  }

  return undefined
}

export function readHeredocDelimiter(args: {
  source: string
  at: number
}): HeredocDelimiter | undefined {
  const { source } = args
  let index = args.at
  while (index < source.length && (source[index] === ' ' || source[index] === '\t')) index += 1

  const quote = source[index]
  if (quote === "'" || quote === '"') {
    const close = source.indexOf(quote, index + 1)
    if (close === -1) return undefined
    return { delimiter: source.slice(index + 1, close), expands: false, next: close + 1 }
  }

  let text = ''
  let escaped = false
  while (index < source.length) {
    const char = source[index]
    if (char === undefined) break
    if (char === '\\') {
      escaped = true
      index += 1
      continue
    }
    if (delimiterStops.includes(char)) break
    text += char
    index += 1
  }

  if (text === '') return undefined
  return { delimiter: text, expands: !escaped, next: index }
}
