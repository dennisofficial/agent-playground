import { describe, expect, it } from 'bun:test'

import { EDefinitionOrigin } from '../origin'
import { resolveShadowing } from '../shadowing'

type Definition = { name: string; body: string; origin: EDefinitionOrigin }

const resolve = (definitions: readonly Definition[]): readonly Definition[] =>
  resolveShadowing({ definitions, nameOf: (definition) => definition.name })

const at = (args: { name: string; origin: EDefinitionOrigin }): Definition => ({
  name: args.name,
  body: `${args.origin} ${args.name}`,
  origin: args.origin,
})

describe('resolveShadowing', () => {
  it('keeps every definition when no name collides', () => {
    const resolved = resolve([
      at({ name: 'plan', origin: EDefinitionOrigin.User }),
      at({ name: 'commit', origin: EDefinitionOrigin.BuiltIn }),
    ])

    expect(resolved.map((definition) => definition.name)).toEqual(['commit', 'plan'])
  })

  it('lets the user shadow a built-in', () => {
    const resolved = resolve([
      at({ name: 'commit', origin: EDefinitionOrigin.BuiltIn }),
      at({ name: 'commit', origin: EDefinitionOrigin.User }),
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.origin).toBe(EDefinitionOrigin.User)
  })

  it('lets the project shadow both the user and the built-in', () => {
    const resolved = resolve([
      at({ name: 'commit', origin: EDefinitionOrigin.BuiltIn }),
      at({ name: 'commit', origin: EDefinitionOrigin.User }),
      at({ name: 'commit', origin: EDefinitionOrigin.Project }),
    ])

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.body).toBe('project commit')
  })

  it('applies precedence regardless of the order the definitions arrive in', () => {
    const resolved = resolve([
      at({ name: 'commit', origin: EDefinitionOrigin.Project }),
      at({ name: 'commit', origin: EDefinitionOrigin.BuiltIn }),
      at({ name: 'commit', origin: EDefinitionOrigin.User }),
    ])

    expect(resolved.map((definition) => definition.origin)).toEqual([EDefinitionOrigin.Project])
  })

  it('keeps the first of two definitions that share a name and an origin', () => {
    const resolved = resolve([
      { name: 'commit', body: 'first', origin: EDefinitionOrigin.Project },
      { name: 'commit', body: 'second', origin: EDefinitionOrigin.Project },
    ])

    expect(resolved.map((definition) => definition.body)).toEqual(['first'])
  })

  it('sorts by name so two runs agree', () => {
    const resolved = resolve([
      at({ name: 'zeta', origin: EDefinitionOrigin.Project }),
      at({ name: 'alpha', origin: EDefinitionOrigin.Project }),
      at({ name: 'mid', origin: EDefinitionOrigin.Project }),
    ])

    expect(resolved.map((definition) => definition.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('yields nothing when there is nothing to resolve', () => {
    expect(resolve([])).toEqual([])
  })
})
