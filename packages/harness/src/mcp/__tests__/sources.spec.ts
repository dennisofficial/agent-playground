import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDefinitionOrigin } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  BuiltInMcpSource,
  CompatMcpSource,
  EMcpRejection,
  FileMcpSource,
  type McpTextReader,
} from '../config/sources'
import { compatMcpFile, projectMcpFile } from '../../settings/paths'

const ENOENT = 'ENOENT'

const absentReader: McpTextReader = () => {
  const error = new Error(`ENOENT: no such file or directory`) as Error & { code: string }
  error.code = ENOENT
  return Promise.reject(error)
}

const deniedReader: McpTextReader = () => {
  const error = new Error('EACCES: permission denied') as Error & { code: string }
  error.code = 'EACCES'
  return Promise.reject(error)
}

const readerReturning = (text: string): McpTextReader => () => Promise.resolve(text)

const projectFile = (args: { cwd: string; read: McpTextReader }) =>
  FileMcpSource.project({ cwd: args.cwd, read: args.read })

describe('BuiltInMcpSource', () => {
  it('is empty on day one', async () => {
    const source = new BuiltInMcpSource()

    expect(source.origin).toBe(EDefinitionOrigin.BuiltIn)
    expect(await source.load()).toEqual({ specs: [], rejections: [] })
  })
})

describe('FileMcpSource', () => {
  it('reads the bare Claude Code shape and stamps origin and file', async () => {
    const { specs, rejections } = await projectFile({
      cwd: '/repo',
      read: readerReturning(JSON.stringify({ linear: { transport: { kind: 'stdio', command: 'npx' } } })),
    }).load()

    expect(rejections).toEqual([])
    expect(specs).toEqual([
      {
        name: 'linear',
        transport: { kind: 'stdio', command: 'npx' },
        origin: EDefinitionOrigin.Project,
        definedIn: projectMcpFile('/repo'),
      },
    ])
  })

  it('reads the wrapped mcpServers shape', async () => {
    const { specs } = await projectFile({
      cwd: '/repo',
      read: readerReturning(
        JSON.stringify({ mcpServers: { docs: { transport: { kind: 'http', url: 'https://example.test/mcp' } } } }),
      ),
    }).load()

    expect(specs.map((spec) => spec.name)).toEqual(['docs'])
  })

  it('keeps a disabled switch-off entry that carries no transport', async () => {
    const { specs, rejections } = await projectFile({
      cwd: '/repo',
      read: readerReturning(JSON.stringify({ linear: { disabled: true } })),
    }).load()

    expect(rejections).toEqual([])
    expect(specs[0]).toMatchObject({ name: 'linear', disabled: true })
    expect(specs[0]?.transport).toBeUndefined()
  })

  it('ignores a name field written inside an entry: the object key is the name', async () => {
    const { specs } = await projectFile({
      cwd: '/repo',
      read: readerReturning(
        JSON.stringify({ linear: { name: 'forged', transport: { kind: 'stdio', command: 'npx' } } }),
      ),
    }).load()

    expect(specs.map((spec) => spec.name)).toEqual(['linear'])
  })

  it('says nothing about a file that is simply not there', async () => {
    expect(await projectFile({ cwd: '/repo', read: absentReader }).load()).toEqual({
      specs: [],
      rejections: [],
    })
  })

  it('reports a file it cannot read rather than staying silent', async () => {
    const { specs, rejections } = await projectFile({ cwd: '/repo', read: deniedReader }).load()

    expect(specs).toEqual([])
    expect(rejections).toEqual([
      {
        rejection: EMcpRejection.Unreadable,
        name: undefined,
        definedIn: projectMcpFile('/repo'),
        origin: EDefinitionOrigin.Project,
        detail: 'EACCES: permission denied',
      },
    ])
  })

  it('reports a file that is not json', async () => {
    const { rejections } = await projectFile({
      cwd: '/repo',
      read: readerReturning('not json {'),
    }).load()

    expect(rejections.map((entry) => entry.rejection)).toEqual([EMcpRejection.NotJson])
    expect(rejections[0]?.definedIn).toBe(projectMcpFile('/repo'))
  })

  it('reports a file whose top level holds no servers', async () => {
    const { rejections } = await projectFile({
      cwd: '/repo',
      read: readerReturning(JSON.stringify(['linear'])),
    }).load()

    expect(rejections.map((entry) => entry.rejection)).toEqual([EMcpRejection.BadShape])
  })

  it('keeps the good entries beside the ones it rejects, naming each', async () => {
    const { specs, rejections } = await projectFile({
      cwd: '/repo',
      read: readerReturning(
        JSON.stringify({
          'bad name': { transport: { kind: 'stdio', command: 'npx' } },
          notransport: {},
          good: { transport: { kind: 'stdio', command: 'npx' } },
        }),
      ),
    }).load()

    expect(specs.map((spec) => spec.name)).toEqual(['good'])
    expect(rejections.map((entry) => [entry.name, entry.rejection])).toEqual([
      ['bad name', EMcpRejection.BadName],
      ['notransport', EMcpRejection.BadEntry],
    ])
    expect(rejections[1]?.detail).toContain('transport')
  })

  it('reads a user file from the atlas home', async () => {
    process.env['ATLAS_HOME'] = mkdtempSync(join(tmpdir(), 'atlas-home-'))
    try {
      const source = FileMcpSource.user({
        read: async (file) => {
          expect(file).toBe(join(process.env['ATLAS_HOME'] ?? '', 'mcp.json'))
          return JSON.stringify({ u: { transport: { kind: 'stdio', command: 'run' } } })
        },
      })

      const { specs } = await source.load()

      expect(source.origin).toBe(EDefinitionOrigin.User)
      expect(specs[0]?.origin).toBe(EDefinitionOrigin.User)
    } finally {
      delete process.env['ATLAS_HOME']
    }
  })
})

describe('CompatMcpSource', () => {
  it('reads the project-root .mcp.json at project rank', async () => {
    const source = new CompatMcpSource({
      cwd: '/repo',
      read: readerReturning(JSON.stringify({ legacy: { transport: { kind: 'stdio', command: 'run' } } })),
    })

    const { specs, rejections } = await source.load()

    expect(rejections).toEqual([])
    expect(source.origin).toBe(EDefinitionOrigin.Project)
    expect(specs[0]).toMatchObject({
      name: 'legacy',
      origin: EDefinitionOrigin.Project,
      definedIn: compatMcpFile('/repo'),
    })
  })

  it('says nothing when the compat file is absent', async () => {
    expect(await new CompatMcpSource({ cwd: '/repo', read: absentReader }).load()).toEqual({
      specs: [],
      rejections: [],
    })
  })
})

describe('file sources against a real disk', () => {
  it('reads only what is written, reporting nothing about an absent file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-mcp-'))
    const source = FileMcpSource.project({ cwd: directory })

    expect(await source.load()).toEqual({ specs: [], rejections: [] })

    mkdirSync(join(directory, '.atlas'))
    writeFileSync(
      join(directory, '.atlas', 'mcp.json'),
      JSON.stringify({ fs: { transport: { kind: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'] } } }),
    )

    const { specs } = await source.load()
    expect(specs[0]?.name).toBe('fs')
    expect(specs[0]?.transport).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'] })
  })

  it('reports a file it cannot open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-mcp-'))
    mkdirSync(join(directory, '.atlas'))
    const locked = join(directory, '.atlas', 'mcp.json')
    writeFileSync(locked, JSON.stringify({}))
    chmodSync(locked, 0o000)

    try {
      const { specs, rejections } = await FileMcpSource.project({ cwd: directory }).load()

      expect(specs).toEqual([])
      expect(rejections.map((entry) => entry.rejection)).toEqual([EMcpRejection.Unreadable])
    } finally {
      chmodSync(locked, 0o600)
    }
  })
})
