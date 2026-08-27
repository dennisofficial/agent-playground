export type KeyPress = {
  name?: string | undefined
  sequence?: string | undefined
  ctrl?: boolean | undefined
  shift?: boolean | undefined
  meta?: boolean | undefined
}

export type Chord = string

const MODIFIERS = ['ctrl', 'shift', 'meta'] as const

type Modifier = (typeof MODIFIERS)[number]

const BASE_SPELLING: Record<string, string> = {
  return: '⏎',
  escape: 'esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  tab: '⇥',
}

const partsOf = (chord: Chord): { base: string; held: ReadonlySet<string> } => {
  const tokens = chord.split('+')
  return { base: tokens[tokens.length - 1] ?? '', held: new Set(tokens.slice(0, -1)) }
}

const isPrintable = (base: string): boolean => [...base].length === 1

const heldIn = (args: { press: KeyPress; modifier: Modifier }): boolean =>
  args.press[args.modifier] ?? false

export function chordMatches(args: { chord: Chord; press: KeyPress }): boolean {
  const { base, held } = partsOf(args.chord)
  if (args.press.name !== base && args.press.sequence !== base) return false

  return MODIFIERS.every((modifier) => {
    if (modifier === 'shift' && isPrintable(base) && !held.has('shift')) return true
    return heldIn({ press: args.press, modifier }) === held.has(modifier)
  })
}

export const spellChord = (chord: Chord): string =>
  chord
    .split('+')
    .map((token) => BASE_SPELLING[token] ?? token)
    .join('+')
