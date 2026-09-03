import { describe, expect, it } from 'bun:test'

import { EToolEffect } from '@dltech/atlas-core'

import { filteredToolRegistry, InMemoryToolRegistry } from '../../../tools/registry'
import { toolNamed } from '../../../tools/__tests__/fixtures'
import { AGENT_TOOL_NAMES, SERVICE_CONTROL_TOOL_NAMES, WORKTREE_TOOL_NAMES } from '../agent-type'

const named = (name: string) =>
  toolNamed({
    name,
    effect: EToolEffect.Read,
    invoke: async () => ({ ok: true as const, output: '', modelText: 'rendered' }),
  })

const wholeToolset = () =>
  new InMemoryToolRegistry([
    named('service_start'),
    named('service_stop'),
    named('service_list'),
    named('read'),
    named('bash'),
  ])

const asAChildSees = () =>
  filteredToolRegistry({
    registry: wholeToolset(),
    deny: [...AGENT_TOOL_NAMES, ...WORKTREE_TOOL_NAMES, ...SERVICE_CONTROL_TOOL_NAMES],
  })

describe('what a child may do with the session’s services', () => {
  it('keeps service_list, so a child can see what is online', () => {
    const child = asAChildSees()

    expect(child.find('service_list')).toBeDefined()
  })

  it('loses start and stop: an ending routes to the starting thread, and a finished child has nothing left to deliver it', () => {
    const child = asAChildSees()

    expect(child.find('service_start')).toBeUndefined()
    expect(child.find('service_stop')).toBeUndefined()
  })

  it('advertises the same split rather than merely refusing by name', () => {
    const offered = asAChildSees()
      .declarations()
      .map((declaration) => declaration.name)

    expect(offered).toEqual(['service_list', 'read', 'bash'])
  })
})
