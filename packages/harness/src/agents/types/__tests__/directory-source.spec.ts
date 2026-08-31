import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDefinitionOrigin } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { EAgentTypeRefusal, type AgentTypeRead } from '../agent-type'
import {
  DirectoryAgentTypeSource,
  readMarkdownDirectory,
  type MarkdownDirectoryRead,
  type UnreadableMarkdown,
} from '../directory-source'

const DIRECTORY = '/agents'

const definition = (description: string, body = 'Prompt.'): string =>
  ['---', `description: ${description}`, '---', body].join('\n')

const fileOf = (args: { name: string; text: string }) => ({
  name: args.name,
  path: join(DIRECTORY, args.name),
  text: args.text,
})

const loadFrom = (
  files: readonly { name: string; text: string }[],
  unreadable: readonly UnreadableMarkdown[] = [],
): Promise<AgentTypeRead> =>
  new DirectoryAgentTypeSource({
    directory: DIRECTORY,
    origin: EDefinitionOrigin.Project,
    read: async (): Promise<MarkdownDirectoryRead> => ({ files: files.map(fileOf), unreadable }),
  }).load()

describe('DirectoryAgentTypeSource', () => {
  it('names each agent type after its file and stamps where it came from', async () => {
    const { types } = await loadFrom([{ name: 'reviewer.md', text: definition('review things') }])

    expect(types).toHaveLength(1)
    expect(types[0]?.name).toBe('reviewer')
    expect(types[0]?.whenToUse).toBe('review things')
    expect(types[0]?.origin).toBe(EDefinitionOrigin.Project)
    expect(types[0]?.definedIn).toBe('/agents/reviewer.md')
  })

  it('keeps the rest of the directory when one file is malformed', async () => {
    const { types } = await loadFrom([
      { name: 'broken.md', text: 'no frontmatter here' },
      { name: 'empty.md', text: '  \n' },
      { name: 'reviewer.md', text: definition('review things') },
    ])

    expect(types.map((agentType) => agentType.name)).toEqual(['reviewer'])
  })

  it('says which file it refused and why, rather than dropping it in silence', async () => {
    const { refusals } = await loadFrom([
      { name: 'broken.md', text: 'no frontmatter here' },
      { name: 'empty.md', text: '  \n' },
      { name: 'reviewer.md', text: definition('review things') },
    ])

    expect(refusals.map((entry) => [entry.definedIn, entry.refusal])).toEqual([
      ['/agents/broken.md', EAgentTypeRefusal.NoDescription],
      ['/agents/empty.md', EAgentTypeRefusal.Empty],
    ])
    expect(refusals[0]?.detail).toContain('description:')
    expect(refusals[0]?.origin).toBe(EDefinitionOrigin.Project)
  })

  it('reports a file it could not read at all as a refusal of that file', async () => {
    const { types, refusals } = await loadFrom(
      [{ name: 'reviewer.md', text: definition('review things') }],
      [{ path: '/agents/locked.md', detail: 'EACCES: permission denied' }],
    )

    expect(types.map((agentType) => agentType.name)).toEqual(['reviewer'])
    expect(refusals).toEqual([
      {
        refusal: EAgentTypeRefusal.Unreadable,
        name: undefined,
        definedIn: '/agents/locked.md',
        origin: EDefinitionOrigin.Project,
        detail: 'EACCES: permission denied',
      },
    ])
  })

  it('yields nothing and refuses nothing when the directory holds nothing', async () => {
    expect(await loadFrom([])).toEqual({ types: [], refusals: [] })
  })
})

describe('readMarkdownDirectory', () => {
  it('reads only markdown files, and carries the path of each', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-agent-types-'))
    writeFileSync(join(directory, 'reviewer.md'), definition('review things'))
    writeFileSync(join(directory, 'notes.txt'), 'not an agent type')
    mkdirSync(join(directory, 'nested'))

    const read = await readMarkdownDirectory(directory)

    expect(read.files.map((file) => file.name)).toEqual(['reviewer.md'])
    expect(read.files[0]?.path).toBe(join(directory, 'reviewer.md'))
    expect(read.files[0]?.text).toContain('review things')
    expect(read.unreadable).toEqual([])
  })

  it('says nothing about a directory that is simply not there', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-agent-types-'))

    expect(await readMarkdownDirectory(join(directory, 'absent'))).toEqual({
      files: [],
      unreadable: [],
    })
  })

  it('reports a directory it cannot read, which is a mistake rather than an absence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-agent-types-'))
    const notADirectory = join(directory, 'agents')
    writeFileSync(notADirectory, 'this should have been a directory')

    const read = await readMarkdownDirectory(notADirectory)

    expect(read.files).toEqual([])
    expect(read.unreadable.map((entry) => entry.path)).toEqual([notADirectory])
  })

  it('reports a markdown file it cannot open while keeping the ones it can', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-agent-types-'))
    writeFileSync(join(directory, 'reviewer.md'), definition('review things'))
    const locked = join(directory, 'locked.md')
    writeFileSync(locked, definition('never read'))
    chmodSync(locked, 0o000)

    const read = await readMarkdownDirectory(directory)

    expect(read.files.map((file) => file.name)).toEqual(['reviewer.md'])
    expect(read.unreadable.map((entry) => entry.path)).toEqual([locked])
    expect(read.unreadable[0]?.detail).toContain('locked.md')

    chmodSync(locked, 0o600)
  })
})
