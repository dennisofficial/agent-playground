import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createHarnessContainer,
  portToken,
  PromptRegistry,
  SkillRegistryPort,
  ToolRegistry,
} from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { bindSkillRegistry, SkillRegistryNotBound } from '../skills-binding'
import { fakeSkill, fakeSkillRegistry } from './fake-app'

const COMPOSE = join(import.meta.dir, '..', 'compose.ts')

const registryOf = (...names: readonly string[]) =>
  fakeSkillRegistry({ skills: names.map((name) => fakeSkill({ name })) })

describe('the skill registry the container ships with', () => {
  it('answers as a working registry, so a binding that never lands fails quietly', () => {
    const shipped = createHarnessContainer().resolve(portToken(SkillRegistryPort))

    expect(typeof shipped.all).toBe('function')
    expect(shipped.byName('pirate')).toBeUndefined()
  })

  it('is what anything resolved before the binding keeps holding', () => {
    const container = createHarnessContainer()
    const early = container.resolve(portToken(SkillRegistryPort))
    const registry = registryOf('pirate')

    bindSkillRegistry({ container, registry })

    expect(early).not.toBe(registry)
    expect(early.byName('pirate')).toBeUndefined()
  })

  it('is out of the way for anything resolved after it', () => {
    const container = createHarnessContainer()
    const registry = registryOf('pirate')

    bindSkillRegistry({ container, registry })

    expect(container.resolve(portToken(SkillRegistryPort))).toBe(registry)
  })
})

describe('bindSkillRegistry', () => {
  it('hands back the very instance it bound, not a copy of it', () => {
    const container = createHarnessContainer()
    const registry = registryOf('pirate')

    const bound = bindSkillRegistry({ container, registry })

    expect(bound).toBe(registry)
  })

  it('leaves the port resolvable as the real registry rather than a phantom', () => {
    const container = createHarnessContainer()
    const registry = registryOf('pirate')

    bindSkillRegistry({ container, registry })

    expect(
      container
        .resolve(portToken(SkillRegistryPort))
        .all()
        .map((one) => one.spec.name),
    ).toEqual(['pirate'])
  })

  it('shows a reload through the container, because nothing swaps the instance out', async () => {
    const container = createHarnessContainer()
    const registry = registryOf('pirate')
    bindSkillRegistry({ container, registry })

    registry.place(fakeSkill({ name: 'shanty' }))
    await container.resolve(portToken(SkillRegistryPort)).reload()

    expect(container.resolve(portToken(SkillRegistryPort)).byName('shanty')).toBeDefined()
  })

  it('refuses a container that hands back something other than what was bound', () => {
    const container = createHarnessContainer()
    const registry = registryOf('pirate')
    const deaf = Object.assign(Object.create(container), {
      register: () => deaf,
      isRegistered: () => true,
      resolve: () => registryOf('impostor'),
    })

    expect(() => bindSkillRegistry({ container: deaf, registry })).toThrow(SkillRegistryNotBound)
  })

  it('refuses a container that swallowed the registration', () => {
    const container = createHarnessContainer()
    const deaf = Object.assign(Object.create(container), {
      register: () => deaf,
      isRegistered: () => false,
    })

    expect(() => bindSkillRegistry({ container: deaf, registry: registryOf('pirate') })).toThrow(
      SkillRegistryNotBound,
    )
  })
})

describe('composeAtlas', () => {
  it('binds the skill registry before the tool set and the prompt registry are resolved', async () => {
    const source = await readFile(COMPOSE, 'utf8')

    const bound = source.indexOf('bindSkillRegistry({')
    const tools = source.indexOf('portToken(ToolRegistry)')
    const prompts = source.indexOf('portToken(PromptRegistry)')

    expect(bound).toBeGreaterThan(-1)
    expect(tools).toBeGreaterThan(bound)
    expect(prompts).toBeGreaterThan(bound)
  })

  it('reads the ports it is pinned against, so a rename cannot quietly retire the check', () => {
    expect(ToolRegistry.name).toBe('ToolRegistry')
    expect(PromptRegistry.name).toBe('PromptRegistry')
  })
})
