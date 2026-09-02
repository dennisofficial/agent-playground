import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { DynamicToolSource, EToolEffect, EWebSearchBackend, type ToolDefinition } from '@dltech/atlas-core'

import { portToken } from '../injection'
import { WebSearchBackendToken, WorktreeDirectoryToken, WorkspaceRoot } from '../tokens'
import { createHarnessContainer } from '../create-harness-container'
import { ToolRegistry } from '../../tools/registry'

const definition = (name: string): ToolDefinition => ({
  name,
  description: `the ${name} tool`,
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

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-composite-wiring-'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const rooted = () => {
  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: root })
  container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })
  container.register(WebSearchBackendToken, { useValue: () => EWebSearchBackend.DuckDuckGo })
  return container
}

describe('the ToolRegistry the container hands out', () => {
  it('composes over an empty dynamic slot by default, so the builtin set is exactly what resolves', () => {
    const registry = rooted().resolve(portToken(ToolRegistry))

    const names = registry.declarations().map((declaration) => declaration.name)
    expect(names).toContain('read')
    expect(names).toContain('bash')
    expect(registry.find('read')?.name).toBe('read')
    expect(registry.find('mcp__fs__read')).toBeUndefined()
  })

  it('unions a registered DynamicToolSource into declarations and find', () => {
    const container = rooted()
    container.register(portToken(DynamicToolSource), {
      useValue: new FakeSource([definition('mcp__fs__read')]),
    })

    const registry = container.resolve(portToken(ToolRegistry))

    expect(registry.declarations().map((declaration) => declaration.name)).toContain('mcp__fs__read')
    expect(registry.find('mcp__fs__read')?.description).toBe('the mcp__fs__read tool')
  })

  it('admits a source registered after the first resolve, because the slot is read per resolve', () => {
    const container = rooted()
    const before = container.resolve(portToken(ToolRegistry))
    expect(before.find('mcp__fs__read')).toBeUndefined()

    container.register(portToken(DynamicToolSource), {
      useValue: new FakeSource([definition('mcp__fs__read')]),
    })

    const after = container.resolve(portToken(ToolRegistry))
    expect(after.find('mcp__fs__read')).toBeDefined()
  })
})
