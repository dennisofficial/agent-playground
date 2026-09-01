import { describe, expect, it } from 'bun:test'

import { EToolEffect } from '@dltech/atlas-core'

import { filteredToolRegistry, InMemoryToolRegistry } from '../../../tools/registry'
import { toolNamed } from '../../../tools/__tests__/fixtures'
import { AGENT_TOOL_NAMES, WORKTREE_TOOL_NAMES } from '../agent-type'

const named = (name: string) =>
  toolNamed({
    name,
    effect: EToolEffect.Read,
    invoke: async () => ({ ok: true as const, output: '', modelText: 'rendered' }),
  })

const wholeToolset = () =>
  new InMemoryToolRegistry([
    named('read'),
    named('bash'),
    named('enter_worktree'),
    named('exit_worktree'),
    named('worktree_list'),
    named('agent_spawn'),
  ])

const asAChildSees = () =>
  filteredToolRegistry({
    registry: wholeToolset(),
    deny: [...AGENT_TOOL_NAMES, ...WORKTREE_TOOL_NAMES],
  })

describe('who may reshape the session', () => {
  it('offers the worktree tools to the agent the developer is talking to', () => {
    const offered = wholeToolset()
      .declarations()
      .map((declaration) => declaration.name)

    expect(offered).toContain('enter_worktree')
    expect(offered).toContain('exit_worktree')
    expect(offered).toContain('worktree_list')
  })

  it('offers none of them to a child, which cannot move a session it does not own', () => {
    const offered = asAChildSees()
      .declarations()
      .map((declaration) => declaration.name)

    expect(offered).toEqual(['read', 'bash'])
  })

  it('refuses to hand a child one by name, not merely to advertise it', () => {
    const child = asAChildSees()

    for (const name of WORKTREE_TOOL_NAMES) expect(child.find(name)).toBeUndefined()
    expect(child.find('read')).toBeDefined()
  })
})
