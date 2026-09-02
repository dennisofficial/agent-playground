import { EDefinitionOrigin } from './origin'

const SHADOWING_RANK: Readonly<Record<EDefinitionOrigin, number>> = {
  [EDefinitionOrigin.BuiltIn]: 0,
  [EDefinitionOrigin.User]: 1,
  [EDefinitionOrigin.Project]: 2,
}

export type OriginatedDefinition = { readonly origin: EDefinitionOrigin }

const inNameOrder = <TDefinition extends OriginatedDefinition>(args: {
  definitions: readonly TDefinition[]
  nameOf: (definition: TDefinition) => string
}): readonly TDefinition[] =>
  [...args.definitions].sort((left, right) => args.nameOf(left).localeCompare(args.nameOf(right)))

export function resolveShadowing<TDefinition extends OriginatedDefinition>(args: {
  definitions: readonly TDefinition[]
  nameOf: (definition: TDefinition) => string
  unshadowable?: EDefinitionOrigin | undefined
}): readonly TDefinition[] {
  const layered: TDefinition[] = []
  const winners = new Map<string, TDefinition>()

  for (const definition of args.definitions) {
    if (definition.origin === args.unshadowable) {
      layered.push(definition)
      continue
    }

    const name = args.nameOf(definition)
    const held = winners.get(name)
    if (held !== undefined && SHADOWING_RANK[held.origin] >= SHADOWING_RANK[definition.origin]) {
      continue
    }
    winners.set(name, definition)
  }

  const { nameOf } = args
  return [
    ...inNameOrder({ definitions: layered, nameOf }),
    ...inNameOrder({ definitions: [...winners.values()], nameOf }),
  ]
}
