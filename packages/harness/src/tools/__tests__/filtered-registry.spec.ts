import { describe, expect, it } from 'bun:test'

import { EToolEffect, toCallId, toRunId, toThreadId } from '@dltech/atlas-core'

import { HookChain } from '../../hooks/registry'
import { HookedToolDispatcher, type DispatchableCall } from '../dispatch'
import { InMemoryToolRegistry, filteredToolRegistry } from '../registry'
import { toolNamed } from './fixtures'

const succeeds = async () => ({ ok: true as const, output: '', modelText: 'rendered' })

const everyTool = () =>
  new InMemoryToolRegistry([
    toolNamed({ name: 'read', invoke: succeeds }),
    toolNamed({ name: 'glob', invoke: succeeds }),
    toolNamed({ name: 'agent_spawn', invoke: succeeds }),
  ])

const namesOf = (registry: { declarations(): readonly { name: string }[] }): string[] =>
  registry.declarations().map((declaration) => declaration.name)

describe('a registry narrowed by a deny list', () => {
  it('refuses to resolve a denied name the underlying registry still holds', () => {
    const underlying = everyTool()
    const narrowed = filteredToolRegistry({ registry: underlying, deny: ['agent_spawn'] })

    expect(underlying.find('agent_spawn')).toBeDefined()
    expect(narrowed.find('agent_spawn')).toBeUndefined()
    expect(narrowed.find('read')).toBeDefined()
  })

  it('drops the denied tool from what the model is shown', () => {
    const narrowed = filteredToolRegistry({ registry: everyTool(), deny: ['agent_spawn'] })

    expect(namesOf(narrowed)).toEqual(['read', 'glob'])
  })
})

describe('a registry narrowed by an allow list', () => {
  it('holds only the allowed tools and resolves nothing outside them', () => {
    const narrowed = filteredToolRegistry({ registry: everyTool(), allow: ['read'] })

    expect(namesOf(narrowed)).toEqual(['read'])
    expect(narrowed.find('glob')).toBeUndefined()
  })

  it('yields an empty registry when the allow list is empty rather than every tool', () => {
    const narrowed = filteredToolRegistry({ registry: everyTool(), allow: [] })

    expect(namesOf(narrowed)).toEqual([])
    expect(narrowed.find('read')).toBeUndefined()
  })

  it('passes every tool through when no allow list is given', () => {
    const narrowed = filteredToolRegistry({ registry: everyTool() })

    expect(namesOf(narrowed)).toEqual(['read', 'glob', 'agent_spawn'])
  })

  it('lets deny win over allow for a name on both lists', () => {
    const narrowed = filteredToolRegistry({
      registry: everyTool(),
      allow: ['read', 'agent_spawn'],
      deny: ['agent_spawn'],
    })

    expect(namesOf(narrowed)).toEqual(['read'])
    expect(narrowed.find('agent_spawn')).toBeUndefined()
  })
})

const everyEffect = () =>
  new InMemoryToolRegistry([
    toolNamed({ name: 'read', effect: EToolEffect.Read, invoke: succeeds }),
    toolNamed({ name: 'write', effect: EToolEffect.Write, invoke: succeeds }),
    toolNamed({ name: 'bash', effect: EToolEffect.Destructive, invoke: succeeds }),
  ])

describe('a registry narrowed by an effect ceiling', () => {
  it('passes every tool through when no ceiling is given', () => {
    const narrowed = filteredToolRegistry({ registry: everyEffect() })

    expect(namesOf(narrowed)).toEqual(['read', 'write', 'bash'])
  })

  it('holds only reading tools under a read ceiling', () => {
    const narrowed = filteredToolRegistry({
      registry: everyEffect(),
      maxEffect: EToolEffect.Read,
    })

    expect(namesOf(narrowed)).toEqual(['read'])
    expect(narrowed.find('write')).toBeUndefined()
    expect(narrowed.find('bash')).toBeUndefined()
  })

  it('admits writing but not destruction under a write ceiling', () => {
    const narrowed = filteredToolRegistry({
      registry: everyEffect(),
      maxEffect: EToolEffect.Write,
    })

    expect(namesOf(narrowed)).toEqual(['read', 'write'])
    expect(narrowed.find('bash')).toBeUndefined()
  })

  it('refuses a tool over the ceiling even when the allow list names it', () => {
    const narrowed = filteredToolRegistry({
      registry: everyEffect(),
      allow: ['read', 'bash'],
      maxEffect: EToolEffect.Read,
    })

    expect(namesOf(narrowed)).toEqual(['read'])
    expect(narrowed.find('bash')).toBeUndefined()
  })

  it('agrees between what it declares and what it resolves under a ceiling', () => {
    const narrowed = filteredToolRegistry({
      registry: everyEffect(),
      maxEffect: EToolEffect.Write,
    })

    for (const name of ['read', 'write', 'bash']) {
      expect(narrowed.find(name) !== undefined).toBe(namesOf(narrowed).includes(name))
    }
  })
})

describe('what a narrowed registry declares and what it resolves', () => {
  it('agrees on every name, so the model is never offered a tool that then fails as unknown', () => {
    const narrowed = filteredToolRegistry({
      registry: everyTool(),
      allow: ['read', 'glob'],
      deny: ['glob'],
    })

    for (const name of ['read', 'glob', 'agent_spawn']) {
      expect(narrowed.find(name) !== undefined).toBe(namesOf(narrowed).includes(name))
    }
  })
})

describe('a dispatcher built over a narrowed registry', () => {
  it('refuses a denied tool called by name, so a child cannot spawn a child', async () => {
    let spawned = false
    const dispatcher = new HookedToolDispatcher({
      registry: filteredToolRegistry({
        registry: new InMemoryToolRegistry([
          toolNamed({ name: 'read', invoke: succeeds }),
          toolNamed({
            name: 'agent_spawn',
            invoke: async () => {
              spawned = true
              return { ok: true, output: '', modelText: 'rendered' }
            },
          }),
        ]),
        deny: ['agent_spawn'],
      }),
      hooks: new HookChain({}),
    })

    const call: DispatchableCall = {
      callId: toCallId('call-1'),
      name: 'agent_spawn',
      input: { path: 'a.ts' },
      runId: toRunId('run-1'),
      threadId: toThreadId('thread-1'),
    }

    const drafts = await dispatcher.dispatch({
      call,
      signal: new AbortController().signal,
      projectDirectory: '/workspace',
    })

    expect(spawned).toBe(false)
    expect(drafts).toHaveLength(1)
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('agent_spawn')
    expect(message).not.toContain('available tools: read, agent_spawn')
  })
})
