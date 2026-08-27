import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { ToolDefinition, type ToolOutcome } from '@dltech/atlas-core'

import { createHarnessContainer } from '../../container/create-harness-container'
import { portToken, resolveSet, type DependencyContainer } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { BashTool } from '../builtin/bash'
import { GlobTool } from '../builtin/glob'
import { GrepTool } from '../builtin/grep'
import { ToolRegistry } from '../registry'

const BUILTIN_NAMES = ['read', 'write', 'edit', 'bash', 'grep', 'glob']

function containerRootedAt(root: string): DependencyContainer {
  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: root })
  return container
}

function toolNamed({ container, name }: { container: DependencyContainer; name: string }): ToolDefinition {
  const tools = resolveSet({ container, token: portToken(ToolDefinition) })
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`the container resolved no tool named "${name}"`)
  return found
}

const invoke = (tool: ToolDefinition, input: unknown): Promise<ToolOutcome> =>
  tool.invoke({ input, signal: AbortSignal.timeout(10_000), idempotencyKey: 'key-1' })

describe('the builtin tools resolved from the container', () => {
  let root: string
  let container: DependencyContainer

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-tool-container-'))
    await Bun.write(join(root, 'kept.ts'), 'export const kept = true\n')
    container = containerRootedAt(root)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves all six against the one ToolDefinition token, in registration order', () => {
    const tools = resolveSet({ container, token: portToken(ToolDefinition) })

    expect(tools.map((tool) => tool.name)).toEqual(BUILTIN_NAMES)
  })

  it('builds a registry that finds every builtin by name', () => {
    const registry = container.resolve(portToken(ToolRegistry))

    expect(registry.declarations().map((declaration) => declaration.name)).toEqual(BUILTIN_NAMES)
    expect(registry.find('bash')).toBeInstanceOf(BashTool)
    expect(registry.find('nothing')).toBeUndefined()
  })

  it('carries each name as a string property rather than deriving it from the class', () => {
    expect(toolNamed({ container, name: 'bash' })).toBeInstanceOf(BashTool)
    expect(toolNamed({ container, name: 'grep' })).toBeInstanceOf(GrepTool)
    expect(BashTool.name).not.toBe('bash')
  })

  it('injects the workspace root into the tools that need one', async () => {
    const outcome = await invoke(toolNamed({ container, name: 'glob' }), { pattern: '*.ts' })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.modelText).toContain('kept.ts')
  })

  it('still invokes as a tool once it is a class rather than a literal', async () => {
    const outcome = await invoke(toolNamed({ container, name: 'read' }), { path: join(root, 'kept.ts') })

    expect(outcome.ok && outcome.modelText).toContain('export const kept = true')
  })
})

describe('tool registration across containers', () => {
  it('binds each container its own root rather than sharing one', async () => {
    const first = mkdtempSync(join(tmpdir(), 'atlas-tool-first-'))
    const second = mkdtempSync(join(tmpdir(), 'atlas-tool-second-'))
    await Bun.write(join(first, 'only-in-first.ts'), '\n')

    try {
      const globIn = (root: string): Promise<ToolOutcome> =>
        invoke(toolNamed({ container: containerRootedAt(root), name: 'glob' }), { pattern: '*.ts' })

      const found = await globIn(first)
      const empty = await globIn(second)

      expect(found.ok && found.modelText).toContain('only-in-first.ts')
      expect(empty.ok && empty.modelText).toBe('No files match that pattern.')
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('refuses to build a registry when the workspace root was never registered', () => {
    const container = createHarnessContainer()

    expect(() => container.resolve(portToken(ToolRegistry))).toThrow()
  })
})
