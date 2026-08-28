import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ECommandGroup, ECommandKind } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { FilesystemSkillSource } from '../filesystem-source'
import { ESkillOrigin, type DiscoveredSkill } from '../skill'

let directory: string

const write = ({ at, content }: { at: string; content: string }): void => {
  const path = join(directory, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const load = (at?: string): Promise<readonly DiscoveredSkill[]> =>
  new FilesystemSkillSource({
    directory: at ?? directory,
    origin: ESkillOrigin.Project,
  }).load()

const only = async (): Promise<DiscoveredSkill> => {
  const loaded = await load()
  const first = loaded[0]
  if (first === undefined) throw new Error('expected exactly one skill')
  expect(loaded).toHaveLength(1)
  return first
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atlas-skills-'))
})

describe('FilesystemSkillSource', () => {
  it('yields nothing when the directory does not exist', async () => {
    expect(await load(join(directory, 'absent'))).toEqual([])
  })

  it('yields nothing when the directory holds no skills', async () => {
    expect(await load()).toEqual([])
  })

  it('reads a flat markdown file and names it after the basename', async () => {
    write({ at: 'Review.md', content: 'look closely' })

    const skill = await only()

    expect(skill.spec).toEqual({
      name: 'review',
      kind: ECommandKind.Skill,
      summary: '',
      group: ECommandGroup.Workspace,
      argumentHint: undefined,
    })
    expect(skill.body).toBe('look closely')
    expect(skill.origin).toBe(ESkillOrigin.Project)
  })

  it('reads a nested SKILL.md and names it after the folder', async () => {
    write({ at: 'review/SKILL.md', content: 'look closely' })
    write({ at: 'review/notes.txt', content: 'sibling' })

    const skill = await only()

    expect(skill.spec.name).toBe('review')
    expect(skill.body).toBe('look closely')
  })

  it('reads both file shapes from the one directory', async () => {
    write({ at: 'commit.md', content: 'commit body' })
    write({ at: 'review/SKILL.md', content: 'review body' })

    const loaded = await load()

    expect(loaded.map((skill) => skill.spec.name).sort()).toEqual(['commit', 'review'])
  })

  it('carries description and argument-hint into the spec', async () => {
    write({
      at: 'review.md',
      content: ['---', 'description: Review a file', 'argument-hint: <path>', '---', 'body'].join('\n'),
    })

    const skill = await only()

    expect(skill.spec.summary).toBe('Review a file')
    expect(skill.spec.argumentHint).toBe('<path>')
    expect(skill.body).toBe('body')
  })

  it('lets a frontmatter name override the basename, lowercased', async () => {
    write({ at: 'review.md', content: ['---', 'name: Deep-Review', '---', 'body'].join('\n') })

    expect((await only()).spec.name).toBe('deep-review')
  })

  it('treats a skill as user- and model-invocable by default', async () => {
    write({ at: 'review.md', content: 'body' })

    const skill = await only()

    expect(skill.userInvocable).toBe(true)
    expect(skill.modelInvocable).toBe(true)
  })

  it('honours user-invocable: false', async () => {
    write({ at: 'review.md', content: ['---', 'user-invocable: false', '---', 'body'].join('\n') })

    const skill = await only()

    expect(skill.userInvocable).toBe(false)
    expect(skill.modelInvocable).toBe(true)
  })

  it('honours disable-model-invocation: true', async () => {
    write({
      at: 'review.md',
      content: ['---', 'disable-model-invocation: TRUE', '---', 'body'].join('\n'),
    })

    const skill = await only()

    expect(skill.userInvocable).toBe(true)
    expect(skill.modelInvocable).toBe(false)
  })

  it('falls back to the defaults when a flag is not a boolean literal', async () => {
    write({
      at: 'review.md',
      content: ['---', 'user-invocable: maybe', 'disable-model-invocation: sometimes', '---', 'b'].join(
        '\n',
      ),
    })

    const skill = await only()

    expect(skill.userInvocable).toBe(true)
    expect(skill.modelInvocable).toBe(true)
  })

  it('tolerates frontmatter keys it does not know', async () => {
    write({
      at: 'review.md',
      content: ['---', 'allowed-tools: Read, Grep', 'model: opus', '---', 'body'].join('\n'),
    })

    expect((await only()).body).toBe('body')
  })

  it('skips an empty file rather than failing the whole directory', async () => {
    write({ at: 'empty.md', content: '   \n\n' })
    write({ at: 'review.md', content: 'body' })

    expect((await load()).map((skill) => skill.spec.name)).toEqual(['review'])
  })

  it('skips a folder without a SKILL.md rather than failing', async () => {
    write({ at: 'assets/logo.txt', content: 'not a skill' })
    write({ at: 'review.md', content: 'body' })

    expect((await load()).map((skill) => skill.spec.name)).toEqual(['review'])
  })

  it('ignores files that are not markdown', async () => {
    write({ at: 'notes.txt', content: 'body' })

    expect(await load()).toEqual([])
  })
})
