import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'bun:test'

import { FilesystemSkillSource } from '../filesystem-source'
import { ESkillInstallLayer, writeSkill } from '../install-writer'
import { ESkillOrigin, type DiscoveredSkill } from '../skill'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'atlas-install-writer-'))
})

const projectRoot = (name: string): string => join(cwd, '.atlas', 'skills', name, 'SKILL.md')

const writeProject = (args: { name: string; body: string }) =>
  writeSkill({ layer: ESkillInstallLayer.Project, cwd, name: args.name, body: args.body })

const firstLoaded = async (): Promise<DiscoveredSkill> => {
  const loaded = await new FilesystemSkillSource({
    directory: join(cwd, '.atlas', 'skills'),
    origin: ESkillOrigin.Project,
  }).load()

  const first = loaded[0]
  if (first === undefined) throw new Error('expected the written skill to load')
  expect(loaded).toHaveLength(1)
  return first
}

describe('writeSkill', () => {
  it('writes <name>/SKILL.md under the project skills root', async () => {
    const written = await writeProject({ name: 'review', body: 'review body' })

    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.path).toBe(projectRoot('review'))
    await expect(Bun.file(written.path).text()).resolves.toBe('review body')
    expect(written.bytes).toBe('review body'.length)
  })

  it('writes into the atlas home when the layer is user', async () => {
    const previous = process.env['ATLAS_HOME']
    const atlasHome = mkdtempSync(join(tmpdir(), 'atlas-home-'))
    process.env['ATLAS_HOME'] = atlasHome

    try {
      const written = await writeSkill({
        layer: ESkillInstallLayer.User,
        cwd,
        name: 'review',
        body: 'user body',
      })

      expect(written.ok).toBe(true)
      if (!written.ok) return
      expect(written.path).toBe(join(atlasHome, 'skills', 'review', 'SKILL.md'))
      await expect(Bun.file(written.path).exists()).resolves.toBe(true)
    } finally {
      if (previous === undefined) delete process.env['ATLAS_HOME']
      else process.env['ATLAS_HOME'] = previous
    }
  })

  it('replaces a same-named skill wholesale', async () => {
    const first = await writeProject({ name: 'review', body: 'first' })
    const second = await writeProject({ name: 'review', body: 'second' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    await expect(Bun.file(second.path).text()).resolves.toBe('second')
  })

  it('rejects an empty or whitespace-only name without touching the disk', async () => {
    for (const name of ['', '   ']) {
      const written = await writeProject({ name, body: 'body' })

      expect(written.ok).toBe(false)
      if (written.ok) continue
      await expect(Bun.file(projectRoot(name)).exists()).resolves.toBe(false)
    }
  })

  it("rejects a name containing '/', so it cannot wander outside the skills root", async () => {
    const written = await writeProject({ name: 'a/b', body: 'body' })

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.reason).toContain("'/'")
  })

  it('rejects a blank body rather than planting an empty file', async () => {
    const written = await writeProject({ name: 'review', body: '  \n\n' })

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.reason).toContain('body')
  })

  it('refuses to run over something at the entry path that is not a regular file', async () => {
    mkdirSync(join(cwd, '.atlas', 'skills', 'review', 'SKILL.md'), { recursive: true })

    const written = await writeProject({ name: 'review', body: 'body' })

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.reason).toContain('not a regular file')
  })

  it('makes what it wrote discoverable by the skills loader', async () => {
    const written = await writeProject({ name: 'review', body: '-- discovery --' })
    if (!written.ok) throw new Error('the write should land before discovery is checked')

    const skill = await firstLoaded()

    expect(skill.spec.name).toBe('review')
    expect(skill.body).toBe('-- discovery --')
  })
})
