export enum EExpansionKind {
  Variable = 'variable',
  Substitution = 'substitution',
}

export type Expansion = {
  kind: EExpansionKind
  text: string
}

export type ExpansionSink = {
  text: string
  expansions: Expansion[]
}

export type VariableResolver = (name: string) => string | undefined

const variableName = /^[A-Za-z_][A-Za-z0-9_]*/
const digit = /^[0-9]$/
const specialParameters = new Set(['@', '*', '#', '?', '$', '!', '-', '0'])

type VariableRead = {
  name: string
  raw: string
  next: number
}

function readVariable({ source, at }: { source: string; at: number }): VariableRead | undefined {
  const rest = source.slice(at + 1)

  if (rest.startsWith('{')) {
    const close = rest.indexOf('}')
    if (close === -1) return undefined
    const inner = rest.slice(1, close)
    const named = variableName.exec(inner)
    if (named === null) return undefined
    return { name: named[0], raw: `\${${inner}}`, next: at + close + 2 }
  }

  const named = variableName.exec(rest)
  if (named !== null) return { name: named[0], raw: `$${named[0]}`, next: at + 1 + named[0].length }

  const first = rest[0]
  if (first === undefined) return undefined
  if (!specialParameters.has(first) && !digit.test(first)) return undefined
  return { name: first, raw: `$${first}`, next: at + 2 }
}

export function readSubstitution({
  source,
  at,
}: {
  source: string
  at: number
}): { raw: string; next: number } | undefined {
  if (source[at] === '`') {
    const close = source.indexOf('`', at + 1)
    if (close === -1) return undefined
    return { raw: source.slice(at, close + 1), next: close + 1 }
  }

  let depth = 0
  let index = at + 1

  while (index < source.length) {
    const char = source[index]
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { raw: source.slice(at, index + 1), next: index + 1 }
    }
    index += 1
  }

  return undefined
}

export function takeExpansion(args: {
  source: string
  at: number
  sink: ExpansionSink
  resolve: VariableResolver | undefined
}): number | undefined {
  const { source, at, sink, resolve } = args

  if (source[at] === '`' || source[at + 1] === '(') {
    const substitution = readSubstitution({ source, at })
    if (substitution === undefined) return undefined
    sink.text += substitution.raw
    sink.expansions.push({ kind: EExpansionKind.Substitution, text: substitution.raw })
    return substitution.next
  }

  const variable = readVariable({ source, at })
  if (variable === undefined) return undefined

  const value = resolve === undefined ? undefined : resolve(variable.name)
  if (value !== undefined) {
    sink.text += value
    return variable.next
  }

  sink.text += variable.raw
  sink.expansions.push({ kind: EExpansionKind.Variable, text: variable.name })
  return variable.next
}

export function expandPlainText(args: {
  source: string
  sink: ExpansionSink
  resolve: VariableResolver | undefined
}): void {
  const { source, sink, resolve } = args
  let index = 0

  while (index < source.length) {
    const char = source[index]

    if (char === '$' || char === '`') {
      const next = takeExpansion({ source, at: index, sink, resolve })
      if (next !== undefined) {
        index = next
        continue
      }
    }

    sink.text += char
    index += 1
  }
}
