import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { DynamicToolSource, EToolEffect, type ToolDefinition } from '@dltech/atlas-core'

import { CompositeToolRegistry } from '../composite-registry'
import { filteredToolRegistry, InMemoryToolRegistry } from '../registry'

const definition = (name: string, description?: string): ToolDefinition => ({
  name,
  description: description ?? `the ${name} tool`,
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: name, modelText: `${name} ran` }),
})

class FakeSource extends DynamicToolSource {
  constructor(readonly held: ToolDefinition[]) {
    super()
  }

  declarations() {
    return this.held
  }

  find(name: string) {
    return this.held.find((tool) => tool.name === name)
  }
}

describe('CompositeToolRegistry', () => {
  it('declares the base set followed by every source, and finds each by name', () => {
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([definition('read'), definition('write')]),
      sources: [new FakeSource([definition('mcp__fs__read')]), new FakeSource([definition('mcp__db__query')])],
    })

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual([
      'read',
      'write',
      'mcp__fs__read',
      'mcp__db__query',
    ])
    expect(registry.find('mcp__fs__read')?.description).toBe('the mcp__fs__read tool')
    expect(registry.find('nothing')).toBeUndefined()
  })

  it('answers a collision from the base first, then from the earlier source', () => {
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([definition('read', 'base read')]),
      sources: [
        new FakeSource([definition('read', 'source read'), definition('grep', 'first grep')]),
        new FakeSource([definition('grep', 'second grep')]),
      ],
    })

    expect(registry.find('read')?.description).toBe('base read')
    expect(registry.find('grep')?.description).toBe('first grep')
  })

  it('reads a source live, so a tool that joins after construction is offered and found', () => {
    const held: ToolDefinition[] = []
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([definition('read')]),
      sources: [new FakeSource(held)],
    })

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual(['read'])

    held.push(definition('mcp__fs__read'))

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual([
      'read',
      'mcp__fs__read',
    ])
    expect(registry.find('mcp__fs__read')).toBeDefined()
  })

  it('reads a source live in the other direction too, so a tool that leaves stops resolving', () => {
    const held = [definition('mcp__fs__read')]
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([]),
      sources: [new FakeSource(held)],
    })

    held.pop()

    expect(registry.declarations()).toEqual([])
    expect(registry.find('mcp__fs__read')).toBeUndefined()
  })

  it('is the base alone when no source is registered', () => {
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([definition('read')]),
      sources: [],
    })

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual(['read'])
  })

  it('narrows a dynamic tool through filteredToolRegistry exactly like a static one', () => {
    const registry = filteredToolRegistry({
      registry: new CompositeToolRegistry({
        base: new InMemoryToolRegistry([definition('read')]),
        sources: [new FakeSource([definition('mcp__fs__read')])],
      }),
      deny: ['mcp__fs__read'],
    })

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual(['read'])
    expect(registry.find('mcp__fs__read')).toBeUndefined()
    expect(registry.find('read')).toBeDefined()
  })
})
