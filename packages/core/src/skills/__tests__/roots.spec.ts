import { describe, expect, it } from 'bun:test'

import { EDefinitionOrigin } from '../../discovery/origin'
import { ESkillRootFlavour, skillRootPlan } from '../roots'

const plan = () =>
  skillRootPlan({
    atlasHome: '/home/dennis/.atlas',
    home: '/home/dennis',
    cwd: '/work/atlas',
    skillsDirectoryName: 'skills',
  })

describe('skillRootPlan', () => {
  it('plans user roots before project roots', () => {
    expect(plan().map((root) => root.directory)).toEqual([
      '/home/dennis/.atlas/skills',
      '/home/dennis/.agents/skills',
      '/home/dennis/.claude/skills',
      '/work/atlas/.atlas/skills',
      '/work/atlas/.agents/skills',
      '/work/atlas/.claude/skills',
    ])
  })

  it('marks the origin of every root', () => {
    expect(plan().map((root) => root.origin)).toEqual([
      EDefinitionOrigin.User,
      EDefinitionOrigin.User,
      EDefinitionOrigin.User,
      EDefinitionOrigin.Project,
      EDefinitionOrigin.Project,
      EDefinitionOrigin.Project,
    ])
  })

  it('marks the flavour of every root', () => {
    expect(plan().map((root) => root.flavour)).toEqual([
      ESkillRootFlavour.Atlas,
      ESkillRootFlavour.Agents,
      ESkillRootFlavour.Claude,
      ESkillRootFlavour.Atlas,
      ESkillRootFlavour.Agents,
      ESkillRootFlavour.Claude,
    ])
  })

  it('honours an atlas home that is not under the user home', () => {
    const roots = skillRootPlan({
      atlasHome: '/opt/atlas-home',
      home: '/home/dennis',
      cwd: '/work/atlas',
      skillsDirectoryName: 'skills',
    })

    expect(roots[0]?.directory).toBe('/opt/atlas-home/skills')
  })

  it('tolerates trailing separators', () => {
    const roots = skillRootPlan({
      atlasHome: '/home/dennis/.atlas/',
      home: '/home/dennis/',
      cwd: '/work/atlas/',
      skillsDirectoryName: 'skills',
    })

    expect(roots.map((root) => root.directory)).toEqual([
      '/home/dennis/.atlas/skills',
      '/home/dennis/.agents/skills',
      '/home/dennis/.claude/skills',
      '/work/atlas/.atlas/skills',
      '/work/atlas/.agents/skills',
      '/work/atlas/.claude/skills',
    ])
  })
})
