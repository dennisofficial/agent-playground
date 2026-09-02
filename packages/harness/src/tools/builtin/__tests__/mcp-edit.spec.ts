import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  toThreadId,
  type ToolOutcome,
} from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { McpEditTool } from '../mcp-edit'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-mcp-edit-tool-'))
})

const invoke = async (input: unknown): Promise<ToolOutcome> =>
  new McpEditTool().invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'edit-1',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

describe('McpEditTool', () => {
  it('is a write over the layer file it resolves', () => {
    const tool = new McpEditTool()

    expect(tool.name).toBe('mcp-edit')
    expect(tool.effect).toBe(EToolEffect.Write)
    expect(tool.pathFields).toEqual([
      {
        field: 'layer',
        presence: EPathPresence.Required,
        form: EPathForm.Absolute,
        content: EContentAccess.Amends,
      },
    ])
  })

  it('upserts through invoke end to end', async () => {
    const outcome = await invoke({
      layer: 'project',
      name: 'linear',
      transport: { kind: 'stdio', command: 'npx' },
      action: 'upsert',
    })

    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) {
      expect(outcome.modelText).toContain('linear')
      expect(outcome.modelText).toContain(join(root, '.atlas', 'mcp.json'))
    }
  })

  it('disables without demanding a transport', async () => {
    const outcome = await invoke({
      layer: 'project',
      name: 'linear',
      action: 'disable',
    })

    expect(outcome).toMatchObject({ ok: true })
  })

  it('enables a stub back over the file', async () => {
    await invoke({ layer: 'project', name: 'linear', action: 'disable' })

    const outcome = await invoke({
      layer: 'project',
      name: 'linear',
      transport: { kind: 'stdio', command: 'run' },
      action: 'enable',
    })

    expect(outcome).toMatchObject({ ok: true })
    const text = JSON.parse(await Bun.file(join(root, '.atlas', 'mcp.json')).text()) as Record<string, unknown>
    expect('disabled' in Object(text['linear'])).toBe(false)
  })

  it('removes, gracefully answering success for a name it never held', async () => {
    const outcome = await invoke({
      layer: 'project',
      name: 'nobody',
      action: 'remove',
    })

    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.ok && outcome.modelText).toContain('removed')
  })

  it('rejects an invalid transport before a byte is written', async () => {
    const outcome = await invoke({
      layer: 'project',
      name: 'badurl',
      transport: { kind: 'http', url: 'no-scheme' },
      action: 'upsert',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('invalid input')
  })

  it('rejects a name whose charset the loaders would reject', async () => {
    const outcome = await invoke({
      layer: 'project',
      name: 'bad name',
      transport: { kind: 'stdio', command: 'npx' },
      action: 'upsert',
    })

    expect(outcome.ok).toBe(false)
    expect(await Bun.file(join(root, '.atlas', 'mcp.json')).exists()).toBe(false)
  })

  it('keeps the trusted flag the input carried', async () => {
    expect(
      (
        await invoke({
          layer: 'project',
          name: 'vouched',
          transport: { kind: 'stdio', command: 'npx' },
          action: 'upsert',
          trusted: true,
        })
      ).ok
    ).toBe(true)

    const text = JSON.parse(await Bun.file(join(root, '.atlas', 'mcp.json')).text()) as Record<string, unknown>
    expect(text['vouched']).toMatchObject({ trusted: true })
  })

  it('writes the user layer where ATLAS_HOME sends it', async () => {
    process.env['ATLAS_HOME'] = root
    try {
      mkdirSync(join(root, '.atlas'))
      writeFileSync(join(root, '.atlas', 'mcp.json'), JSON.stringify({}))

      const outcome = await invoke({
        layer: 'user',
        name: 'home',
        transport: { kind: 'http', url: 'https://example.test/mcp' },
        action: 'upsert',
      })

      expect(outcome).toMatchObject({ ok: true })
      if (outcome.ok) expect(outcome.output).toMatchObject({ path: join(root, 'mcp.json') })
    } finally {
      delete process.env['ATLAS_HOME']
    }
  })

  it('writes the compat file at the project root for project-compat', async () => {
    const outcome = await invoke({
      layer: 'project-compat',
      name: 'legacy',
      transport: { kind: 'stdio', command: 'run' },
      action: 'upsert',
    })

    expect(outcome).toMatchObject({ ok: true })
    if (outcome.ok) expect(outcome.output).toMatchObject({ path: join(root, '.mcp.json') })
  })
})
