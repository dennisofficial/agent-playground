import { describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const credentialsDirectory = join(import.meta.dir, '..')

const readCredentialSources = async (): Promise<{ name: string; text: string }[]> => {
  const entries = await readdir(credentialsDirectory, { withFileTypes: true })
  const sources = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))

  return Promise.all(
    sources.map(async (entry) => ({
      name: entry.name,
      text: await Bun.file(join(credentialsDirectory, entry.name)).text(),
    })),
  )
}

describe('credentials sources', () => {
  it('write nothing to the console', async () => {
    for (const source of await readCredentialSources()) {
      expect(source.text).not.toContain('console.')
      expect(source.text).not.toContain('process.stdout')
      expect(source.text).not.toContain('process.stderr')
    }
  })

  it('carry no live Anthropic token prefix', async () => {
    for (const source of await readCredentialSources()) {
      expect(source.text).not.toContain('sk-ant-')
    }
  })
})
