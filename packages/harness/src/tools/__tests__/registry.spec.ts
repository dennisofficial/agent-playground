import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { EToolEffect, type ToolDefinition } from '@dltech/atlas-core'

import { createToolRegistry } from '../registry'

const definition = (name: string): ToolDefinition => ({
  name,
  description: `the ${name} tool`,
  effect: EToolEffect.Read,
  inputSchema: z.object({ path: z.string() }),
  invoke: async () => ({ ok: true, output: name, modelText: 'rendered' }),
})

describe('createToolRegistry', () => {
  it('declares every tool it holds to the model and finds each one by name', () => {
    const registry = createToolRegistry([definition('read'), definition('glob')])

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual(['read', 'glob'])
    expect(registry.find('glob')?.description).toBe('the glob tool')
    expect(registry.find('bash')).toBeUndefined()
  })

  it('refuses two tools under one name at construction, naming the collision', () => {
    expect(() => createToolRegistry([definition('read'), definition('read')])).toThrow(/read/)
  })
})
