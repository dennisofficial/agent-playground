import { describe, expect, it } from 'bun:test'

import { createHarnessContainer } from '../create-harness-container'
import { portToken } from '../injection'
import { WorkspaceRoot, WorktreeDirectoryToken } from '../tokens'
import { ToolRegistry } from '../../tools/registry'

describe('resolving the toolset the composition root builds', () => {
  it('constructs every tool, worktree tools included, from the registered tokens', () => {
    const container = createHarnessContainer()
    container.register(WorkspaceRoot, { useValue: '/w' })
    container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })

    const names = container
      .resolve(portToken(ToolRegistry))
      .declarations()
      .map((declaration) => declaration.name)

    expect(names).toContain('enter_worktree')
    expect(names).toContain('exit_worktree')
    expect(names).toContain('worktree_list')
  })

  it('names the missing token rather than failing somewhere downstream', () => {
    const container = createHarnessContainer()
    container.register(WorkspaceRoot, { useValue: '/w' })

    expect(() => container.resolve(portToken(ToolRegistry))).toThrow(/WorktreeDirectory/)
  })
})
