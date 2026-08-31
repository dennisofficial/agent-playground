import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EDefinitionOrigin } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import type { AgentType } from '../agent-type'
import {
  DirectoryAgentTypeSource,
  readMarkdownDirectory,
  type MarkdownFile,
} from '../directory-source'

const definition = (description: string, body = 'Prompt.'): string =>
  ['---', `description: ${description}`, '---', body].join('\n')

const loadFrom = (files: readonly MarkdownFile[]): Promise<readonly AgentType[]> =>
  new DirectoryAgentTypeSource({
    directory: '/agents',
    origin: EDefinitionOrigin.Project,
    read: async () => files,
  }).load()

describe('DirectoryAgentTypeSource', () => {
  it('names each agent type after its file and stamps the origin', async () => {
    const loaded = await loadFrom([{ name: 'reviewer.md', text: definition('review things') }])

    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.name).toBe('reviewer')
    expect(loaded[0]?.whenToUse).toBe('review things')
    expect(loaded[0]?.origin).toBe(EDefinitionOrigin.Project)
  })

  it('skips a malformed file instead of failing the whole directory', async () => {
    const loaded = await loadFrom([
      { name: 'broken.md', text: 'no frontmatter here' },
      { name: 'empty.md', text: '  \n' },
      { name: 'reviewer.md', text: definition('review things') },
    ])

    expect(loaded.map((agentType) => agentType.name)).toEqual(['reviewer'])
  })

  it('yields nothing when the directory holds nothing', async () => {
    expect(await loadFrom([])).toEqual([])
  })
})

describe('readMarkdownDirectory', () => {
  it('reads only markdown files, and yields nothing for a missing directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-agent-types-'))
    writeFileSync(join(directory, 'reviewer.md'), definition('review things'))
    writeFileSync(join(directory, 'notes.txt'), 'not an agent type')
    mkdirSync(join(directory, 'nested'))

    const files = await readMarkdownDirectory(directory)

    expect(files.map((file) => file.name)).toEqual(['reviewer.md'])
    expect(files[0]?.text).toContain('review things')
    expect(await readMarkdownDirectory(join(directory, 'absent'))).toEqual([])
  })
})
