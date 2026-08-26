import type { ToolDeclaration, ToolDefinition } from '@dltech/atlas-core'

export type ToolRegistry = {
  declarations(): readonly ToolDeclaration[]
  find(name: string): ToolDefinition | undefined
}

export function createToolRegistry(definitions: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>()
  for (const definition of definitions) {
    if (byName.has(definition.name)) throw new Error(`two tools are registered as "${definition.name}"`)
    byName.set(definition.name, definition)
  }

  return {
    declarations: () => definitions,
    find: (name) => byName.get(name),
  }
}
