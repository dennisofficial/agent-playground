import { EToolEffect } from './tool'

const EFFECT_ORDER: Readonly<Record<EToolEffect, number>> = {
  [EToolEffect.Read]: 0,
  [EToolEffect.Write]: 1,
  [EToolEffect.Destructive]: 2,
}

export const TOOL_EFFECTS: readonly EToolEffect[] = Object.values(EToolEffect)

export function toToolEffect(written: string): EToolEffect | undefined {
  return TOOL_EFFECTS.find((effect) => effect === written)
}

export function permitsEffect(args: {
  effect: EToolEffect
  ceiling: EToolEffect | undefined
}): boolean {
  if (args.ceiling === undefined) return true
  return EFFECT_ORDER[args.effect] <= EFFECT_ORDER[args.ceiling]
}
