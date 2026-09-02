import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EContentAccess,
  EToolEffect,
  toThreadId,
  type ToolOutcome,
} from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { ESkillInstallLayer } from '../../../skills/install-writer'
import { SkillInstallTool } from '../skill-install'

let cwd: string
let tool: SkillInstallTool

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'atlas-skill-install-'))
  tool = new SkillInstallTool()
})

const invoke = (input: unknown, projectDirectory: string = cwd): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: AbortSignal.timeout(10_000),
    idempotencyKey: 'key-1',
    projectDirectory,
    threadId: toThreadId('thread-1'),
  })

const at = (name: string): Promise<ToolOutcome> =>
  invoke({ layer: ESkillInstallLayer.Project, name, body: 'the body' })

describe('SkillInstallTool', () => {
  it('writes the body under the project skills root', async () => {
    const outcome = await at('review')

    expect(outcome.ok).toBe(true)
    const path = join(cwd, '.atlas', 'skills', 'review', 'SKILL.md')
    await expect(Bun.file(path).exists()).resolves.toBe(true)
    await expect(Bun.file(path).text()).resolves.toBe('the body')

    if (outcome.ok) {
      expect(outcome.output).toMatchObject({ path, name: 'review' })
      expect(outcome.modelText).toContain(path)
    }
  })

  it('overwrites a same-named skill', async () => {
    const first = await at('review')
    const second = await at('review')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    const path = join(cwd, '.atlas', 'skills', 'review', 'SKILL.md')
    await expect(Bun.file(path).text()).resolves.toBe('the body')
  })

  it('rejects a blank name', async () => {
    const outcome = await invoke({ layer: ESkillInstallLayer.Project, name: '  ', body: 'body' })

    expect(outcome.ok).toBe(false)
    await expect(Bun.file(join(cwd, '.atlas', 'skills', '  ')).exists()).resolves.toBe(false)
  })

  it("rejects a name with '/'", async () => {
    const outcome = await invoke({ layer: ESkillInstallLayer.Project, name: 'a/b', body: 'body' })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("'/'")
  })

  it('rejects an empty body so the skill would never hold nothing', async () => {
    const outcome = await invoke({ layer: ESkillInstallLayer.Project, name: 'review', body: '  ' })

    expect(outcome.ok).toBe(false)
  })

  it('rejects a missing layer, too', async () => {
    const outcome = await invoke({ name: 'review', body: 'body' })

    expect(outcome.ok).toBe(false)
  })

  it('writes into the atlas home when the layer is user', async () => {
    const previous = process.env['ATLAS_HOME']
    const atlasHome = mkdtempSync(join(tmpdir(), 'atlas-home-'))
    process.env['ATLAS_HOME'] = atlasHome

    try {
      const outcome = await invoke({
        layer: ESkillInstallLayer.User,
        name: 'review',
        body: 'user body',
      })

      expect(outcome.ok).toBe(true)
      const path = join(atlasHome, 'skills', 'review', 'SKILL.md')
      await expect(Bun.file(path).exists()).resolves.toBe(true)
    } finally {
      if (previous === undefined) delete process.env['ATLAS_HOME']
      else process.env['ATLAS_HOME'] = previous
    }
  })

  it('declares the destination under the write effect', () => {
    expect(tool.effect).toBe(EToolEffect.Write)
    expect(tool.pathFields).toHaveLength(1)
    expect(tool.pathFields?.[0]?.content).toBe(EContentAccess.Overwrites)
    expect(tool.pathFields?.[0]?.field).toBe('name')
  })
})
