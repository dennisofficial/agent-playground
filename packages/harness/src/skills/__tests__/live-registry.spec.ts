import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDefinitionOrigin, ESkillRootFlavour, type SkillRoot } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { EmbeddedSkillSource } from '../embedded-source'
import { LiveSkillRegistry } from '../live-registry'
import { resolveSkillRoots, skillSourcesFor } from '../roots'
import { SkillSource, type DiscoveredSkill } from '../skill'

let workspace: string

const projectRoot = (at: string): SkillRoot => ({
  directory: join(workspace, at),
  origin: EDefinitionOrigin.Project,
  flavour: ESkillRootFlavour.Atlas,
})

const writeSkill = (args: { at: string; name: string; body: string }): void => {
  const directory = join(workspace, args.at, args.name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), args.body)
}

const overRoots = (plan: readonly SkillRoot[]): LiveSkillRegistry =>
  new LiveSkillRegistry({
    sources: async () => [
      new EmbeddedSkillSource(),
      ...skillSourcesFor({ roots: await resolveSkillRoots({ plan }) }),
    ],
  })

class ExplodingSource extends SkillSource {
  readonly origin = EDefinitionOrigin.Project

  async load(): Promise<readonly DiscoveredSkill[]> {
    throw new Error('this source is broken')
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'atlas-live-skills-'))
})

describe('LiveSkillRegistry', () => {
  it('reads as empty until the first reload', () => {
    const registry = overRoots([projectRoot('skills')])

    expect(registry.all()).toEqual([])
    expect(registry.byName('commit')).toBeUndefined()
  })

  it('holds what the first reload found and returns the same set', async () => {
    writeSkill({ at: 'skills', name: 'review', body: 'review body' })

    const registry = overRoots([projectRoot('skills')])
    const returned = await registry.reload()

    expect(returned.map((skill) => skill.spec.name)).toEqual(['commit', 'review'])
    expect(registry.all()).toBe(returned)
  })

  it('answers byName case-insensitively and in the qualified form', async () => {
    writeSkill({ at: 'skills', name: 'review', body: 'review body' })

    const registry = overRoots([projectRoot('skills')])
    await registry.reload()

    expect(registry.byName('review')?.body).toBe('review body')
    expect(registry.byName('  REVIEW ')?.body).toBe('review body')
    expect(registry.byName('skill:review')?.body).toBe('review body')
    expect(registry.byName('Skill:Review')?.body).toBe('review body')
    expect(registry.byName('absent')).toBeUndefined()
  })

  it('picks up a skill added to disk mid-session', async () => {
    const registry = overRoots([projectRoot('skills')])
    mkdirSync(join(workspace, 'skills'), { recursive: true })
    await registry.reload()

    expect(registry.byName('review')).toBeUndefined()

    writeSkill({ at: 'skills', name: 'review', body: 'review body' })
    await registry.reload()

    expect(registry.byName('review')?.body).toBe('review body')
    expect(registry.all().map((skill) => skill.spec.name)).toEqual(['commit', 'review'])
  })

  it('re-runs root resolution, so a root created mid-session starts contributing', async () => {
    const registry = overRoots([projectRoot('skills')])
    await registry.reload()

    expect(registry.all().map((skill) => skill.spec.name)).toEqual(['commit'])

    writeSkill({ at: 'skills', name: 'review', body: 'review body' })
    await registry.reload()

    expect(registry.byName('review')?.body).toBe('review body')
  })

  it('drops a skill removed from disk on the next reload', async () => {
    writeSkill({ at: 'skills', name: 'review', body: 'review body' })

    const registry = overRoots([projectRoot('skills')])
    await registry.reload()
    rmSync(join(workspace, 'skills', 'review'), { recursive: true })
    await registry.reload()

    expect(registry.byName('review')).toBeUndefined()
  })

  it('lets the last reload win immediately, without a further read', async () => {
    writeSkill({ at: 'skills', name: 'review', body: 'first' })

    const registry = overRoots([projectRoot('skills')])
    await registry.reload()
    writeSkill({ at: 'skills', name: 'review', body: 'second' })
    await registry.reload()

    expect(registry.all().map((skill) => skill.body)).toEqual(expect.arrayContaining(['second']))
    expect(registry.byName('review')?.body).toBe('second')
  })

  it('lets a source that throws contribute nothing rather than failing the reload', async () => {
    writeSkill({ at: 'skills', name: 'review', body: 'review body' })

    const registry = new LiveSkillRegistry({
      sources: async () => [
        new ExplodingSource(),
        ...skillSourcesFor({ roots: await resolveSkillRoots({ plan: [projectRoot('skills')] }) }),
      ],
    })

    expect((await registry.reload()).map((skill) => skill.spec.name)).toEqual(['review'])
  })

  it('holds nothing rather than throwing when the plan itself fails', async () => {
    const registry = new LiveSkillRegistry({
      sources: () => {
        throw new Error('no plan')
      },
    })

    expect(await registry.reload()).toEqual([])
    expect(registry.all()).toEqual([])
  })

  it('yields nothing from a root that does not exist', async () => {
    const registry = new LiveSkillRegistry({
      sources: async () =>
        skillSourcesFor({ roots: await resolveSkillRoots({ plan: [projectRoot('absent')] }) }),
    })

    expect(await registry.reload()).toEqual([])
  })

  it('keeps a project skill shadowing a built-in of the same name', async () => {
    writeSkill({ at: 'skills', name: 'commit', body: 'project commit' })

    const registry = overRoots([projectRoot('skills')])
    await registry.reload()

    expect(registry.all()).toHaveLength(1)
    expect(registry.byName('commit')?.body).toBe('project commit')
  })
})
