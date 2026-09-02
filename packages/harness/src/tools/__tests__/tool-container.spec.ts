import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { EWebSearchBackend, ToolDefinition, type ToolOutcome,
  toThreadId,
} from '@dltech/atlas-core'

import { createHarnessContainer } from '../../container/create-harness-container'
import { disposeAll } from '../../container/disposal'
import { portToken, resolveSet, type DependencyContainer } from '../../container/injection'
import {
  WebSearchBackendToken,
  WorktreeDirectoryToken,
  WorkspaceRoot,
} from '../../container/tokens'
import { BashTool } from '../builtin/bash'
import { GlobTool } from '../builtin/glob'
import { GrepTool } from '../builtin/grep'
import { ToolRegistry } from '../registry'

const BUILTIN_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'shell_list',
  'shell_output',
  'shell_kill',
  'task_write',
  'skill',
  'agent_spawn',
  'agent_say',
  'agent_resume',
  'agent_list',
  'agent_stop',
  'enter_worktree',
  'exit_worktree',
  'worktree_list',
  'web_fetch',
  'web_search',
]

function containerRootedAt(root: string): DependencyContainer {
  const container = createHarnessContainer()
  container.register(WorkspaceRoot, { useValue: root })
  container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })
  container.register(WebSearchBackendToken, { useValue: () => EWebSearchBackend.DuckDuckGo })
  return container
}

function toolNamed({ container, name }: { container: DependencyContainer; name: string }): ToolDefinition {
  const tools = resolveSet({ container, token: portToken(ToolDefinition) })
  const found = tools.find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`the container resolved no tool named "${name}"`)
  return found
}

const invoke = (
  tool: ToolDefinition,
  input: unknown,
  projectDirectory = tmpdir(),
): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: AbortSignal.timeout(10_000),
    idempotencyKey: 'key-1',
    projectDirectory,
    threadId: toThreadId('thread-1'),
  })

describe('the builtin tools resolved from the container', () => {
  let root: string
  let container: DependencyContainer

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'atlas-tool-container-'))
    await Bun.write(join(root, 'kept.ts'), 'export const kept = true\n')
    container = containerRootedAt(root)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves every builtin against the one ToolDefinition token, in registration order', () => {
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

  it('scans the session directory when the call names no path of its own', async () => {
    const outcome = await invoke(toolNamed({ container, name: 'glob' }), { pattern: '*.ts' }, root)

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
        invoke(toolNamed({ container: containerRootedAt(root), name: 'glob' }), { pattern: '*.ts' }, root)

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

describe('the background shell registry the tools share', () => {
  it('hands bash, shell_output and shell_kill the same registry, so a shell one starts the others can see', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-shared-shells-'))
    const container = containerRootedAt(root)

    try {
      const started = await invoke(
        toolNamed({ container, name: 'bash' }),
        { command: 'sleep 30', description: 'Idle in the background', runInBackground: true },
        root,
      )
      expect(started.ok).toBe(true)
      if (!started.ok) return

      const shellId = (started.output as { shellId: string }).shellId
      const read = await invoke(toolNamed({ container, name: 'shell_output' }), { shellId })
      const killed = await invoke(toolNamed({ container, name: 'shell_kill' }), { shellId })

      expect(read.ok).toBe(true)
      expect(killed.ok).toBe(true)
    } finally {
      await disposeAll({ container })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('gives each container its own registry rather than sharing one process-wide', async () => {
    const first = mkdtempSync(join(tmpdir(), 'atlas-shells-first-'))
    const second = mkdtempSync(join(tmpdir(), 'atlas-shells-second-'))
    const containers = [containerRootedAt(first), containerRootedAt(second)] as const

    try {
      const started = await invoke(
        toolNamed({ container: containers[0], name: 'bash' }),
        { command: 'sleep 30', description: 'Idle in the background', runInBackground: true },
        tmpdir(),
      )
      expect(started.ok).toBe(true)
      if (!started.ok) return

      const shellId = (started.output as { shellId: string }).shellId
      const elsewhere = await invoke(toolNamed({ container: containers[1], name: 'shell_output' }), { shellId })

      expect(elsewhere.ok).toBe(false)
    } finally {
      for (const container of containers) await disposeAll({ container })
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('kills what it started when the container is torn down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-shells-teardown-'))
    const container = containerRootedAt(root)
    const witness = join(root, 'zombie.txt')

    try {
      await invoke(toolNamed({ container, name: 'bash' }), {
        command: `sleep 2; echo alive > ${witness}`,
        description: 'Leave a witness behind',
        runInBackground: true,
      })
      await Bun.sleep(150)

      await disposeAll({ container })
      await Bun.sleep(2200)

      expect(await Bun.file(witness).exists()).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
