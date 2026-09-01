import { ECommandGroup, ECommandKind } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { EmbeddedSkillSource } from '../embedded-source'
import { ESkillOrigin } from '../skill'

describe('EmbeddedSkillSource', () => {
  it('names every built-in after its manifest path and marks it built-in', async () => {
    const loaded = await new EmbeddedSkillSource().load()

    expect(loaded.length).toBeGreaterThan(0)
    for (const skill of loaded) {
      expect(skill.origin).toBe(ESkillOrigin.BuiltIn)
      expect(skill.spec.kind).toBe(ECommandKind.Skill)
      expect(skill.spec.group).toBe(ECommandGroup.Workspace)
      expect(skill.spec.name).toMatch(/^[a-z][a-z0-9:-]*$/)
      expect(skill.directory).toBeUndefined()
      expect(skill.entryPath).toBeUndefined()
      expect(skill.warnings).toEqual([])
    }
  })

  it('carries the commit built-in with its frontmatter and body', async () => {
    const loaded = await new EmbeddedSkillSource().load()
    const commit = loaded.find((skill) => skill.spec.name === 'commit')

    expect(commit?.spec.summary).not.toBe('')
    expect(commit?.spec.argumentHint).toBe('[scope]')
    expect(commit?.body).toContain('<type>(<scope>): <description>')
    expect(commit?.userInvocable).toBe(true)
    expect(commit?.modelInvocable).toBe(true)
    expect(commit?.frontmatter.name).toBe('commit')
  })
})
