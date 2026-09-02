import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { FileMcpSource } from '../config/sources'
import {
  EMcpEditAction,
  EMcpEditLayer,
  run,
  type McpEditInput,
} from '../config/writer'
import { compatMcpFile, projectMcpFile, userMcpFile } from '../../settings/paths'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-mcp-writer-'))
})

const edit = async (input: McpEditInput): Promise<ToolOutcome> =>
  await run({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'writer-1',
    projectDirectory: root,
    activeWorktree: undefined,
    threadId: toThreadId('thread-1'),
  })

const fileAtUserLayer = (): string => {
  process.env['ATLAS_HOME'] = root
  return userMcpFile()
}

const projectServers = () => FileMcpSource.project({ cwd: root })

describe('mcp writer', () => {
  it('installs an upsert into a project file that was never there', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'linear',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', '@mcp/linear'] },
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: true })

    const { specs, rejections } = await projectServers().load()
    expect(rejections).toEqual([])
    expect(specs[0]).toMatchObject({
      name: 'linear',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', '@mcp/linear'] },
    })
  })

  it('keeps the entries it knows nothing about, in the order they were written', async () => {
    mkdirSync(join(root, '.atlas'))
    writeFileSync(
      join(root, '.atlas', 'mcp.json'),
      JSON.stringify({
        kept: { transport: { kind: 'stdio', command: 'hold' } },
        second: { disabled: true },
        third: { transport: { kind: 'http', url: 'https://example.test/mcp' } },
      }),
    )

    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'kept',
      transport: { kind: 'stdio', command: 'renewed' },
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: true })
    const { specs } = await projectServers().load()
    expect(specs.map((spec) => spec.name)).toEqual(['kept', 'second', 'third'])
  })

  it('round-trips a wrapped mcpServers file back into the wrapped shape', async () => {
    mkdirSync(join(root, '.atlas'))
    writeFileSync(
      join(root, '.atlas', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { transport: { kind: 'http', url: 'https://example.test/mcp' } } } }),
    )

    await edit({
      layer: EMcpEditLayer.Project,
      name: 'extra',
      transport: { kind: 'stdio', command: 'npx' },
      action: EMcpEditAction.Upsert,
    })

    const text = JSON.parse(await Bun.file(projectMcpFile(root)).text()) as Record<string, unknown>
    expect(Object.keys(text)).toEqual(['mcpServers'])
  })

  it('writes a disable stub that needs no transport and shadows nothing upstream', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'linear',
      action: EMcpEditAction.Disable,
    })

    expect(outcome).toMatchObject({ ok: true })

    const { specs, rejections } = await projectServers().load()
    expect(rejections).toEqual([])
    expect(specs[0]).toMatchObject({ name: 'linear', disabled: true })
    expect(specs[0]?.transport).toBeUndefined()
  })

  it('enables a stub back into a live server when it carries a transport', async () => {
    await edit({ layer: EMcpEditLayer.Project, name: 'linear', action: EMcpEditAction.Disable })

    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'linear',
      transport: { kind: 'stdio', command: 'run' },
      action: EMcpEditAction.Enable,
    })

    expect(outcome).toMatchObject({ ok: true })

    const { specs, rejections } = await projectServers().load()
    expect(rejections).toEqual([])
    expect(specs[0]).toMatchObject({
      name: 'linear',
      transport: { kind: 'stdio', command: 'run' },
    })
    expect(specs[0]?.disabled).toBeUndefined()
  })

  it('writes the user layer wherever ATLAS_HOME points it', async () => {
    const path = fileAtUserLayer()
    try {
      const outcome = await edit({
        layer: EMcpEditLayer.User,
        name: 'home-server',
        transport: { kind: 'http', url: 'https://example.test/mcp' },
        action: EMcpEditAction.Upsert,
      })

      expect(outcome).toMatchObject({ ok: true })
      expect((outcome as { ok: true; output: unknown }).output).toMatchObject({ path })
    } finally {
      delete process.env['ATLAS_HOME']
    }
  })

  it('toggles the compat file at the project root when that layer is chosen', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.ProjectCompat,
      name: 'legacy',
      transport: { kind: 'stdio', command: 'run' },
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: true })
    expect((outcome as { ok: true; output: unknown }).output).toMatchObject({
      path: compatMcpFile(root),
    })
  })

  it('answers success for removing a name that was never there, leaving the file alone', async () => {
    mkdirSync(join(root, '.atlas'))
    const path = join(root, '.atlas', 'mcp.json')
    writeFileSync(path, JSON.stringify({ kept: { transport: { kind: 'stdio', command: 'hold' } } }))

    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'stranger',
      action: EMcpEditAction.Remove,
    })

    expect(outcome).toMatchObject({ ok: true })
    expect(await Bun.file(path).text()).toBe(`${JSON.stringify({ kept: { transport: { kind: 'stdio', command: 'hold' } } }, null, 2)}\n`)
  })

  it('removes only the entry it names', async () => {
    mkdirSync(join(root, '.atlas'))
    writeFileSync(
      join(root, '.atlas', 'mcp.json'),
      JSON.stringify({
        kept: { transport: { kind: 'stdio', command: 'hold' } },
        gone: { transport: { kind: 'stdio', command: 'leave' } },
      }),
    )

    await edit({ layer: EMcpEditLayer.Project, name: 'gone', action: EMcpEditAction.Remove })

    const { specs } = await projectServers().load()
    expect(specs.map((spec) => spec.name)).toEqual(['kept'])
  })

  it('upserts then removes until nothing names the server again', async () => {
    await edit({
      layer: EMcpEditLayer.Project,
      name: 'ephemeral',
      transport: { kind: 'stdio', command: 'npx' },
      action: EMcpEditAction.Upsert,
    })
    await edit({ layer: EMcpEditLayer.Project, name: 'ephemeral', action: EMcpEditAction.Remove })

    const { specs } = await projectServers().load()
    expect(specs).toEqual([])
  })

  it('refuses an upsert that carries no transport, and never touches the file', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'homeless',
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.reason).toContain('transport')
    expect(await Bun.file(projectMcpFile(root)).exists()).toBe(false)
  })

  it('refuses a transport the loaders would reject', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'badurl',
      transport: { kind: 'http', url: 'no-scheme-here' } as McpEditInput['transport'],
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: false })
    expect(await Bun.file(projectMcpFile(root)).exists()).toBe(false)
  })

  it('refuses a name the loaders would reject for its charset', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'bad name!',
      transport: { kind: 'stdio', command: 'npx' },
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.reason).toContain('server "bad name!"')
  })

  it('carries the trusted flag into the file it writes', async () => {
    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'vouched',
      transport: { kind: 'stdio', command: 'npx' },
      action: EMcpEditAction.Upsert,
      trusted: true,
    })

    expect(outcome).toMatchObject({ ok: true })

    const { specs } = await projectServers().load()
    expect(specs[0]).toMatchObject({ name: 'vouched', trusted: true })
  })

  it('says which existing entry is broken rather than overwriting around it', async () => {
    mkdirSync(join(root, '.atlas'))
    writeFileSync(
      join(root, '.atlas', 'mcp.json'),
      JSON.stringify({ broken: { transport: { kind: 'http', url: 'no-scheme-here' } } }),
    )

    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'newcomer',
      transport: { kind: 'stdio', command: 'npx' },
      action: EMcpEditAction.Upsert,
    })

    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.reason).toContain('broken')
  })

  it('refuses a file that is not json', async () => {
    mkdirSync(join(root, '.atlas'))
    writeFileSync(join(root, '.atlas', 'mcp.json'), 'not json {')

    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'anything',
      action: EMcpEditAction.Remove,
    })

    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.reason).toContain('not json')
  })

  it('refuses a layer path that is not a regular file', async () => {
    mkdirSync(join(root, '.atlas'))
    mkdirSync(join(root, '.atlas', 'mcp.json'))

    const outcome = await edit({
      layer: EMcpEditLayer.Project,
      name: 'anything',
      action: EMcpEditAction.Remove,
    })

    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.reason).toContain('not a regular file')
  })
})
