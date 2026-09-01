import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ECommandGroup, ECommandKind, ESkillWarning } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { FilesystemSkillSource } from '../filesystem-source'
import { ESkillOrigin, type DiscoveredSkill } from '../skill'

let directory: string
let elsewhere: string

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

const codesOf = (skill: DiscoveredSkill): readonly ESkillWarning[] =>
  skill.warnings.map((warning) => warning.code)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atlas-skills-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'atlas-skills-away-'))
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

  it('accepts the entry file whatever its casing', async () => {
    write({ at: 'review/skill.md', content: 'lowercase entry' })

    const skill = await only()

    expect(skill.spec.name).toBe('review')
    expect(skill.entryPath).toBe(join(directory, 'review', 'skill.md'))
  })

  it('accepts a mixed-case entry file', async () => {
    write({ at: 'review/Skill.MD', content: 'mixed entry' })

    expect((await only()).body).toBe('mixed entry')
  })

  it('reads both file shapes from the one directory', async () => {
    write({ at: 'commit.md', content: 'commit body' })
    write({ at: 'review/SKILL.md', content: 'review body' })

    const loaded = await load()

    expect(loaded.map((skill) => skill.spec.name).sort()).toEqual(['commit', 'review'])
  })

  it('keeps the folder a nested skill was found in so its bundle stays reachable', async () => {
    write({ at: 'review/SKILL.md', content: 'body' })
    write({ at: 'review/references/rubric.md', content: 'rubric' })
    write({ at: 'review/scripts/run.sh', content: 'echo' })

    const skill = await only()

    expect(skill.directory).toBe(join(directory, 'review'))
    expect(skill.entryPath).toBe(join(directory, 'review', 'SKILL.md'))
  })

  it('gives a flat skill the folder that contains it', async () => {
    write({ at: 'review.md', content: 'body' })

    const skill = await only()

    expect(skill.directory).toBe(directory)
    expect(skill.entryPath).toBe(join(directory, 'review.md'))
  })

  it('follows a symlinked skill directory', async () => {
    const target = join(elsewhere, 'review')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'linked body')
    symlinkSync(target, join(directory, 'review'), 'dir')

    const skill = await only()

    expect(skill.spec.name).toBe('review')
    expect(skill.body).toBe('linked body')
    expect(skill.directory).toBe(join(directory, 'review'))
  })

  it('follows a symlinked flat markdown file', async () => {
    const target = join(elsewhere, 'review.md')
    writeFileSync(target, 'linked body')
    symlinkSync(target, join(directory, 'review.md'))

    expect((await only()).body).toBe('linked body')
  })

  it('skips a symlink whose target is gone', async () => {
    symlinkSync(join(elsewhere, 'nowhere'), join(directory, 'review'), 'dir')
    write({ at: 'commit.md', content: 'body' })

    expect((await load()).map((skill) => skill.spec.name)).toEqual(['commit'])
  })

  it('carries description and argument-hint into the spec', async () => {
    write({
      at: 'review.md',
      content: ['---', 'description: Review a file', 'argument-hint: <path>', '---', 'body'].join(
        '\n',
      ),
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
    expect(skill.frontmatter.userInvocable).toBe(true)
    expect(skill.frontmatter.modelInvocable).toBe(true)
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
      content: ['---', 'disable-model-invocation: true', '---', 'body'].join('\n'),
    })

    const skill = await only()

    expect(skill.userInvocable).toBe(true)
    expect(skill.modelInvocable).toBe(false)
  })

  it('keeps a skill whose frontmatter is unusable, warning instead of dropping it', async () => {
    write({ at: 'review.md', content: ['---', 'description:', '---', 'body'].join('\n') })

    const skill = await only()

    expect(skill.spec.name).toBe('review')
    expect(codesOf(skill)).toContain(ESkillWarning.MissingDescription)
  })

  it('warns when a nested skill names itself something other than its folder', async () => {
    write({ at: 'review/SKILL.md', content: ['---', 'name: audit', '---', 'body'].join('\n') })

    expect(codesOf(await only())).toContain(ESkillWarning.NameDirectoryMismatch)
  })

  it('does not hold a flat skill to a directory name', async () => {
    write({ at: 'review.md', content: ['---', 'name: audit', '---', 'body'].join('\n') })

    const skill = await only()

    expect(skill.spec.name).toBe('audit')
    expect(codesOf(skill)).not.toContain(ESkillWarning.NameDirectoryMismatch)
  })

  it('tolerates frontmatter keys it does not know', async () => {
    write({
      at: 'review.md',
      content: ['---', 'allowed-tools: Read, Grep', 'sprocket: yes', '---', 'body'].join('\n'),
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
