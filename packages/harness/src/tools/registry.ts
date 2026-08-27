import { ToolDefinition, type ToolDeclaration } from '@dltech/atlas-core'

import { injectAll, injectable, portToken } from '../container/injection'

export abstract class ToolRegistry {
  abstract declarations(): readonly ToolDeclaration[]
  abstract find(name: string): ToolDefinition | undefined
}

@injectable()
export class InMemoryToolRegistry extends ToolRegistry {
  private readonly definitions: readonly ToolDefinition[]
  private readonly byName: Map<string, ToolDefinition>

  constructor(@injectAll(portToken(ToolDefinition)) definitions: readonly ToolDefinition[]) {
    super()
    this.byName = new Map()
    for (const definition of definitions) {
      if (this.byName.has(definition.name)) {
        throw new Error(`two tools are registered as "${definition.name}"`)
      }
      this.byName.set(definition.name, definition)
    }
    this.definitions = definitions
  }

  declarations(): readonly ToolDeclaration[] {
    return this.definitions
  }

  find(name: string): ToolDefinition | undefined {
    return this.byName.get(name)
  }
}
