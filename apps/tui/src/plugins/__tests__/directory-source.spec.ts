import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'bun:test'

import { EDefinitionOrigin, resolveShadowing } from '@dltech/atlas-core'

import { listPluginPaths, loadPluginDirectory } from '../directory-source'
import { installPluginApi } from '../install-api'
import { EPluginRefusal } from '../validate'

beforeAll(() => {
  installPluginApi()
})

const freshDirectory = (): string => mkdtempSync(join(tmpdir(), 'atlas-plugins-'))

const write = (args: { directory: string; name: string; source: string }): string => {
  const path = join(args.directory, args.name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, args.source)
  return path
}

const sourceFor = (id: string): string => `
import { definePlugin, EHookPhase, EStage } from 'atlas'

export default definePlugin({
  id: '${id}',
  register: () => ({
    hooks: [
      {
        phase: EHookPhase.BeforeTool,
        name: 'guard',
        order: { stage: EStage.Guard, nudge: 0 },
        run: async () => ({ decision: 'allow', input: {} }),
      },
    ],
  }),
})
`

const loadUser = (directory: string) =>
  loadPluginDirectory({ directory, origin: EDefinitionOrigin.User })

describe('listPluginPaths', () => {
  it('treats an absent directory as empty rather than an error', async () => {
    const listing = await listPluginPaths(join(freshDirectory(), 'never-created'))

    expect(listing).toEqual({ paths: [], unreadable: [] })
  })

  it('takes a bare file, an index inside a directory, and neither dotfiles nor declarations', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'one.ts', source: sourceFor('one') })
    write({ directory, name: 'two/index.tsx', source: sourceFor('two') })
    write({ directory, name: '.hidden.ts', source: sourceFor('hidden') })
    write({ directory, name: 'shipped.d.ts', source: 'export {}' })
    write({ directory, name: 'notes.md', source: '# notes' })

    const listing = await listPluginPaths(directory)

    expect(listing.paths).toEqual([join(directory, 'one.ts'), join(directory, 'two', 'index.tsx')])
    expect(listing.unreadable).toEqual([])
  })

  it('reports a directory that holds no index instead of skipping it silently', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'lopsided/helper.ts', source: 'export const helper = 1' })

    const listing = await listPluginPaths(directory)

    expect(listing.paths).toEqual([])
    expect(listing.unreadable[0]?.detail).toContain('index.ts')
  })
})

describe('loadPluginDirectory', () => {
  it('loads a plugin that imports the atlas module and keeps its register callable', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'conventions.ts', source: sourceFor('conventions') })

    const read = await loadUser(directory)

    expect(read.refusals).toEqual([])
    expect(read.plugins).toHaveLength(1)
    expect(read.plugins[0]?.plugin.id).toBe('conventions')
    expect(read.plugins[0]?.origin).toBe(EDefinitionOrigin.User)
    expect(read.plugins[0]?.definedIn).toBe(join(directory, 'conventions.ts'))
  })

  it('gives the plugin the host EStage, not a lookalike', async () => {
    const { EStage } = await import('@dltech/atlas-core')
    const directory = freshDirectory()
    write({
      directory,
      name: 'staged.ts',
      source: `
import { definePlugin, EStage } from 'atlas'
export const stage = EStage
export default definePlugin({ id: 'staged', register: () => ({}) })
`,
    })

    const loadedModule: { stage: unknown } = await import(join(directory, 'staged.ts'))

    expect(loadedModule.stage).toBe(EStage)
  })

  it('is empty and unbothered when the directory does not exist', async () => {
    const read = await loadUser(join(freshDirectory(), 'absent'))

    expect(read).toEqual({ plugins: [], refusals: [] })
  })

  it('refuses the file that will not parse and still loads its neighbours', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'broken.ts', source: 'export default definePlugin({ id: ' })
    write({ directory, name: 'sound.ts', source: sourceFor('sound') })

    const read = await loadUser(directory)

    expect(read.plugins.map((entry) => entry.plugin.id)).toEqual(['sound'])
    expect(read.refusals).toHaveLength(1)
    expect(read.refusals[0]?.refusal).toBe(EPluginRefusal.Unreadable)
    expect(read.refusals[0]?.definedIn).toBe(join(directory, 'broken.ts'))
  })

  it('refuses a module with no default export', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'sideways.ts', source: 'export const plugin = { id: "sideways" }' })

    const read = await loadUser(directory)

    expect(read.plugins).toEqual([])
    expect(read.refusals[0]?.refusal).toBe(EPluginRefusal.NoDefaultExport)
  })

  it('refuses a wrong-shaped default export and names the file', async () => {
    const directory = freshDirectory()
    write({
      directory,
      name: 'misshapen.ts',
      source: 'export default { id: 12, register: () => ({}) }',
    })

    const read = await loadUser(directory)

    expect(read.refusals[0]?.refusal).toBe(EPluginRefusal.IdNotAString)
    expect(read.refusals[0]?.definedIn).toBe(join(directory, 'misshapen.ts'))
  })

  it('refuses the second file to claim an id and keeps the first', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'a-first.ts', source: sourceFor('twice') })
    write({ directory, name: 'b-second.ts', source: sourceFor('twice') })

    const read = await loadUser(directory)

    expect(read.plugins.map((entry) => entry.definedIn)).toEqual([join(directory, 'a-first.ts')])
    expect(read.refusals[0]?.refusal).toBe(EPluginRefusal.DuplicateId)
    expect(read.refusals[0]?.id).toBe('twice')
  })

  it('lets a project plugin shadow a user plugin of the same id', async () => {
    const userDirectory = freshDirectory()
    const projectDirectory = freshDirectory()
    write({ directory: userDirectory, name: 'github.ts', source: sourceFor('github') })
    write({ directory: projectDirectory, name: 'github.ts', source: sourceFor('github') })

    const user = await loadUser(userDirectory)
    const project = await loadPluginDirectory({
      directory: projectDirectory,
      origin: EDefinitionOrigin.Project,
    })

    const winners = resolveShadowing({
      definitions: [...user.plugins, ...project.plugins],
      nameOf: (entry) => entry.plugin.id,
    })

    expect(winners).toHaveLength(1)
    expect(winners[0]?.origin).toBe(EDefinitionOrigin.Project)
    expect(winners[0]?.definedIn).toBe(join(projectDirectory, 'github.ts'))
  })

  it('routes every import through the importer it was handed', async () => {
    const directory = freshDirectory()
    write({ directory, name: 'unused.ts', source: 'throw new Error("never evaluated")' })

    const read = await loadPluginDirectory({
      directory,
      origin: EDefinitionOrigin.Project,
      importModule: async () => ({
        default: (await import('../api')).atlasPluginApi.definePlugin({
          id: 'faked',
          register: () => ({}),
        }),
      }),
    })

    expect(read.plugins.map((entry) => entry.plugin.id)).toEqual(['faked'])
  })
})
