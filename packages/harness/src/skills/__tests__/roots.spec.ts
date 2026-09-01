import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDefinitionOrigin, ESkillRootFlavour, type SkillRoot } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { loadSkills } from '../registry'
import { resolveSkillRoots, skillSourcesFor } from '../roots'

let workspace: string

const rootOf = (args: {
  at: string
  origin?: EDefinitionOrigin
  flavour?: ESkillRootFlavour
}): SkillRoot => ({
  directory: join(workspace, args.at),
  origin: args.origin ?? EDefinitionOrigin.Project,
  flavour: args.flavour ?? ESkillRootFlavour.Atlas,
})

const writeSkill = (args: { at: string; name: string; body: string }): void => {
  const directory = join(workspace, args.at, args.name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), args.body)
}

const accepted = async (plan: readonly SkillRoot[]): Promise<readonly string[]> =>
  (await resolveSkillRoots({ plan })).map((root) => root.directory)

const bodies = async (plan: readonly SkillRoot[]): Promise<readonly string[]> => {
  const roots = await resolveSkillRoots({ plan })
  const loaded = await loadSkills({ sources: skillSourcesFor({ roots }) })
  return loaded.map((skill) => skill.body)
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'atlas-skill-roots-'))
})

describe('resolveSkillRoots', () => {
  it('drops a root that does not exist', async () => {
    writeSkill({ at: 'present', name: 'review', body: 'here' })

    expect(await accepted([rootOf({ at: 'present' }), rootOf({ at: 'absent' })])).toEqual([
      join(workspace, 'present'),
    ])
  })

  it('drops a root whose path is a file rather than a directory', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'not a root')

    expect(await accepted([rootOf({ at: 'notes.md' })])).toEqual([])
  })

  it('keeps every distinct root in plan order', async () => {
    writeSkill({ at: 'first', name: 'a', body: 'a' })
    writeSkill({ at: 'second', name: 'b', body: 'b' })

    expect(await accepted([rootOf({ at: 'first' }), rootOf({ at: 'second' })])).toEqual([
      join(workspace, 'first'),
      join(workspace, 'second'),
    ])
  })

  it('keeps the first of two roots that realpath to the same directory', async () => {
    writeSkill({ at: 'agents/skills', name: 'review', body: 'shared' })
    mkdirSync(join(workspace, 'claude'), { recursive: true })
    symlinkSync(join(workspace, 'agents/skills'), join(workspace, 'claude/skills'), 'dir')

    const plan = [
      rootOf({ at: 'agents/skills', flavour: ESkillRootFlavour.Agents }),
      rootOf({ at: 'claude/skills', flavour: ESkillRootFlavour.Claude }),
    ]

    expect(await accepted(plan)).toEqual([join(workspace, 'agents/skills')])
  })

  it('loads the skills behind a symlinked duplicate root exactly once', async () => {
    writeSkill({ at: 'agents/skills', name: 'review', body: 'shared' })
    mkdirSync(join(workspace, 'claude'), { recursive: true })
    symlinkSync(join(workspace, 'agents/skills'), join(workspace, 'claude/skills'), 'dir')

    const plan = [
      rootOf({ at: 'agents/skills', flavour: ESkillRootFlavour.Agents }),
      rootOf({ at: 'claude/skills', flavour: ESkillRootFlavour.Claude }),
    ]

    expect(await bodies(plan)).toEqual(['shared'])
  })

  it('drops a root nested inside an already accepted root', async () => {
    writeSkill({ at: 'outer', name: 'review', body: 'outer' })
    mkdirSync(join(workspace, 'outer/inner'), { recursive: true })

    expect(await accepted([rootOf({ at: 'outer' }), rootOf({ at: 'outer/inner' })])).toEqual([
      join(workspace, 'outer'),
    ])
  })

  it('drops a root that symlinks into an already accepted root', async () => {
    writeSkill({ at: 'outer', name: 'review', body: 'outer' })
    mkdirSync(join(workspace, 'outer/inner'), { recursive: true })
    symlinkSync(join(workspace, 'outer/inner'), join(workspace, 'link'), 'dir')

    expect(await accepted([rootOf({ at: 'outer' }), rootOf({ at: 'link' })])).toEqual([
      join(workspace, 'outer'),
    ])
  })

  it('keeps a root that merely shares a path prefix with an accepted root', async () => {
    writeSkill({ at: 'skills', name: 'a', body: 'a' })
    writeSkill({ at: 'skills-extra', name: 'b', body: 'b' })

    expect(await accepted([rootOf({ at: 'skills' }), rootOf({ at: 'skills-extra' })])).toEqual([
      join(workspace, 'skills'),
      join(workspace, 'skills-extra'),
    ])
  })
})

describe('skillSourcesFor', () => {
  it('binds one source per root, carrying the origin through', () => {
    const sources = skillSourcesFor({
      roots: [
        rootOf({ at: 'user', origin: EDefinitionOrigin.User }),
        rootOf({ at: 'project', origin: EDefinitionOrigin.Project }),
      ],
    })

    expect(sources.map((source) => source.origin)).toEqual([
      EDefinitionOrigin.User,
      EDefinitionOrigin.Project,
    ])
  })

  it('lets .atlas shadow .agents and .agents shadow .claude at one origin level', async () => {
    writeSkill({ at: 'claude', name: 'review', body: 'claude' })
    writeSkill({ at: 'agents', name: 'review', body: 'agents' })
    writeSkill({ at: 'atlas', name: 'review', body: 'atlas' })

    const plan = [
      rootOf({ at: 'atlas', flavour: ESkillRootFlavour.Atlas }),
      rootOf({ at: 'agents', flavour: ESkillRootFlavour.Agents }),
      rootOf({ at: 'claude', flavour: ESkillRootFlavour.Claude }),
    ]

    expect(await bodies(plan)).toEqual(['atlas'])
    expect(await bodies(plan.slice(1))).toEqual(['agents'])
  })

  it('lets the project shadow the user whatever the flavour', async () => {
    writeSkill({ at: 'project-claude', name: 'review', body: 'project' })
    writeSkill({ at: 'user-atlas', name: 'review', body: 'user' })

    const plan = [
      rootOf({
        at: 'user-atlas',
        origin: EDefinitionOrigin.User,
        flavour: ESkillRootFlavour.Atlas,
      }),
      rootOf({
        at: 'project-claude',
        origin: EDefinitionOrigin.Project,
        flavour: ESkillRootFlavour.Claude,
      }),
    ]

    expect(await bodies(plan)).toEqual(['project'])
  })
})
