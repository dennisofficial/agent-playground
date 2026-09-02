import {
  ToolDefinition,
  permitsEffect,
  type EToolEffect,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import {  portToken } from '../container/injection'

export abstract class ToolRegistry {
  abstract declarations(): readonly ToolDeclaration[]
  abstract find(name: string): ToolDefinition | undefined
}

export class InMemoryToolRegistry extends ToolRegistry {
  private readonly definitions: readonly ToolDefinition[]
  private readonly byName: Map<string, ToolDefinition>

  constructor( definitions: readonly ToolDefinition[]) {
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
  private readonly maxEffect: EToolEffect | undefined

  constructor(args: {
    registry: ToolRegistry
    allow?: readonly string[] | undefined
    deny?: readonly string[] | undefined
    maxEffect?: EToolEffect | undefined
  }) {
    super()
    this.registry = args.registry
    this.allowed = args.allow === undefined ? undefined : new Set(args.allow)
    this.denied = new Set(args.deny ?? [])
    this.maxEffect = args.maxEffect
  }

  private permitsName(name: string): boolean {
    if (this.denied.has(name)) return false
    return this.allowed === undefined || this.allowed.has(name)
  }

  private permitsEffectOf(declaration: Pick<ToolDeclaration, 'effect'>): boolean {
    return permitsEffect({ effect: declaration.effect, ceiling: this.maxEffect })
  }

  declarations(): readonly ToolDeclaration[] {
    return this.registry
      .declarations()
      .filter(
        (declaration) => this.permitsName(declaration.name) && this.permitsEffectOf(declaration),
      )
  }

  find(name: string): ToolDefinition | undefined {
    if (!this.permitsName(name)) return undefined

    const found = this.registry.find(name)
    if (found === undefined || !this.permitsEffectOf(found)) return undefined
    return found
  }
}

export function filteredToolRegistry(args: {
  registry: ToolRegistry
  allow?: readonly string[] | undefined
  deny?: readonly string[] | undefined
  maxEffect?: EToolEffect | undefined
}): ToolRegistry {
  return new FilteredToolRegistry(args)
}
