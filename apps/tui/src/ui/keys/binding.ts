import { chordMatches, type Chord, type KeyPress } from './chord'

export enum EKeyLayer {
  Global = 0,
  Block = 1,
}

export enum EKeyGroup {
  Composer = 'Composer',
  Session = 'Session',
  Turn = 'Turn',
}

export type KeyDeclaration = { chord: Chord; hint: string; describe?: string }

export type KeyBinding = KeyDeclaration & {
  layer: EKeyLayer
  group?: EKeyGroup | undefined
  run: () => boolean | void
}

export type PlacedBinding = KeyBinding & { placed: number }

export function candidatesFor(args: {
  press: KeyPress
  bindings: readonly PlacedBinding[]
}): readonly PlacedBinding[] {
  return args.bindings
    .filter((binding) => chordMatches({ chord: binding.chord, press: args.press }))
    .sort((left, right) => right.layer - left.layer || right.placed - left.placed)
}

export function pressHandled(args: {
  press: KeyPress
  bindings: readonly PlacedBinding[]
}): boolean {
  for (const binding of candidatesFor(args)) {
    if (binding.run() !== false) return true
  }
  return false
}

export const describedBy = (binding: KeyDeclaration): string => binding.describe ?? binding.hint
