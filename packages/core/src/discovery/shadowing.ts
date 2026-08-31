import { EDefinitionOrigin } from './origin'

const SHADOWING_RANK: Readonly<Record<EDefinitionOrigin, number>> = {
  [EDefinitionOrigin.BuiltIn]: 0,
  [EDefinitionOrigin.User]: 1,
  [EDefinitionOrigin.Project]: 2,
}

export type OriginatedDefinition = { readonly origin: EDefinitionOrigin }

export function resolveShadowing<TDefinition extends OriginatedDefinition>(args: {
  definitions: readonly TDefinition[]
  nameOf: (definition: TDefinition) => string
}): readonly TDefinition[] {
  const winners = new Map<string, TDefinition>()

  for (const definition of args.definitions) {
    const name = args.nameOf(definition)
    const held = winners.get(name)
    if (held !== undefined && SHADOWING_RANK[held.origin] >= SHADOWING_RANK[definition.origin]) {
      continue
    }
    winners.set(name, definition)
  }

  return [...winners.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, definition]) => definition)
}
