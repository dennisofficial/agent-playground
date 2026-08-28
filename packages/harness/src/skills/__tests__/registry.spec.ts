import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'bun:test'

import { EmbeddedSkillSource } from '../embedded-source'
import { FilesystemSkillSource } from '../filesystem-source'
import { loadSkills } from '../registry'
import { ESkillOrigin } from '../skill'

let home: string
let repository: string

const write = ({ root, at, content }: { root: string; at: string; content: string }): void => {
  const path = join(root, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const userSource = () =>
  new FilesystemSkillSource({ directory: home, origin: ESkillOrigin.User })

const projectSource = () =>
  new FilesystemSkillSource({ directory: repository, origin: ESkillOrigin.Project })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atlas-user-skills-'))
  repository = mkdtempSync(join(tmpdir(), 'atlas-project-skills-'))
})

describe('loadSkills', () => {
  it('merges every source when no name collides', async () => {
    write({ root: home, at: 'plan.md', content: 'user plan' })
    write({ root: repository, at: 'review.md', content: 'project review' })

    const loaded = await loadSkills({
      sources: [new EmbeddedSkillSource(), userSource(), projectSource()],
    })

    expect(loaded.map((skill) => skill.spec.name)).toEqual(['commit', 'plan', 'review'])
  })

  it('lets the user shadow a built-in', async () => {
    write({ root: home, at: 'commit.md', content: 'user commit' })

    const loaded = await loadSkills({ sources: [new EmbeddedSkillSource(), userSource()] })

    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.origin).toBe(ESkillOrigin.User)
    expect(loaded[0]?.body).toBe('user commit')
  })

  it('lets the project shadow both the user and the built-in', async () => {
    write({ root: home, at: 'commit.md', content: 'user commit' })
    write({ root: repository, at: 'commit.md', content: 'project commit' })

    const loaded = await loadSkills({
      sources: [new EmbeddedSkillSource(), userSource(), projectSource()],
    })

    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.origin).toBe(ESkillOrigin.Project)
    expect(loaded[0]?.body).toBe('project commit')
  })

  it('applies precedence regardless of the order the sources are passed in', async () => {
    write({ root: home, at: 'commit.md', content: 'user commit' })
    write({ root: repository, at: 'commit.md', content: 'project commit' })

    const loaded = await loadSkills({
      sources: [projectSource(), new EmbeddedSkillSource(), userSource()],
    })

    expect(loaded.map((skill) => skill.origin)).toEqual([ESkillOrigin.Project])
    expect(loaded[0]?.body).toBe('project commit')
  })

  it('sorts by name so two runs agree', async () => {
    write({ root: repository, at: 'zeta.md', content: 'z' })
    write({ root: repository, at: 'alpha/SKILL.md', content: 'a' })
    write({ root: repository, at: 'mid.md', content: 'm' })

    const loaded = await loadSkills({ sources: [projectSource(), new EmbeddedSkillSource()] })

    expect(loaded.map((skill) => skill.spec.name)).toEqual(['alpha', 'commit', 'mid', 'zeta'])
  })

  it('yields nothing when no source has anything to offer', async () => {
    expect(await loadSkills({ sources: [] })).toEqual([])
  })
})
