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

class FilteredToolRegistry extends ToolRegistry {
  private readonly registry: ToolRegistry
  private readonly allowed: ReadonlySet<string> | undefined
  private readonly denied: ReadonlySet<string>

  constructor(args: {
    registry: ToolRegistry
    allow?: readonly string[] | undefined
    deny?: readonly string[] | undefined
  }) {
    super()
    this.registry = args.registry
    this.allowed = args.allow === undefined ? undefined : new Set(args.allow)
    this.denied = new Set(args.deny ?? [])
  }

  private permits(name: string): boolean {
    if (this.denied.has(name)) return false
    return this.allowed === undefined || this.allowed.has(name)
  }

  declarations(): readonly ToolDeclaration[] {
    return this.registry.declarations().filter((declaration) => this.permits(declaration.name))
  }

  find(name: string): ToolDefinition | undefined {
    if (!this.permits(name)) return undefined
    return this.registry.find(name)
  }
}

export function filteredToolRegistry(args: {
  registry: ToolRegistry
  allow?: readonly string[] | undefined
  deny?: readonly string[] | undefined
}): ToolRegistry {
  return new FilteredToolRegistry(args)
}
