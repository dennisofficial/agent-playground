const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
}

const SUBSCRIPT: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  o: 'ₒ',
  x: 'ₓ',
  h: 'ₕ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  p: 'ₚ',
  s: 'ₛ',
  t: 'ₜ',
}

function translate(args: { run: string; table: Record<string, string> }): string | null {
  let out = ''
  for (const point of args.run) {
    const mapped = args.table[point]
    if (mapped === undefined) return null
    out += mapped
  }
  return out
}

export function superscript(run: string): string | null {
  return translate({ run, table: SUPERSCRIPT })
}

export function subscript(run: string): string | null {
  return translate({ run, table: SUBSCRIPT })
}

export function superscriptNumber(value: number): string {
  return translate({ run: String(value), table: SUPERSCRIPT }) ?? String(value)
}

const SUPERSCRIPT_RUN = /\^([^\s^]+)\^/g

export function raiseSuperscripts(text: string): string {
  return text.replace(SUPERSCRIPT_RUN, (whole, run: string) => superscript(run) ?? whole)
}
