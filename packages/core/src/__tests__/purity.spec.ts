import { describe, expect, it } from 'bun:test'

import packageManifest from '../../package.json'

const sourceRoot = new URL('..', import.meta.url).pathname

const readSources = async (): Promise<{ path: string; text: string }[]> => {
  const paths = [...new Bun.Glob('**/*.ts').scanSync(sourceRoot)].filter(
    (path) => !path.includes('__tests__'),
  )

  return Promise.all(
    paths.map(async (path) => ({ path, text: await Bun.file(`${sourceRoot}${path}`).text() })),
  )
}

const offendingLines = async (pattern: RegExp): Promise<string[]> => {
  const sources = await readSources()
  return sources.flatMap(({ path, text }) =>
    text
      .split('\n')
      .filter((line) => pattern.test(line))
      .map((line) => `${path}: ${line.trim()}`),
  )
}

describe('@dltech/atlas-core is pure', () => {
  it('depends on zod and nothing else', () => {
    expect(Object.keys(packageManifest.dependencies)).toEqual(['zod'])
  })

  it('has source files to check', async () => {
    expect((await readSources()).length).toBeGreaterThan(10)
  })

  it('imports no AI SDK package', async () => {
    expect(await offendingLines(/from\s+['"](ai|@ai-sdk\/[^'"]*)['"]/)).toEqual([])
  })

  it('imports nothing but zod and its own relative modules', async () => {
    expect(await offendingLines(/from\s+['"](?!\.\.?\/)(?!zod['"])/)).toEqual([])
  })

  it('reaches for no filesystem, network, database or process', async () => {
    expect(
      await offendingLines(/\b(require\(|fetch\(|(?<![\w/])process\.|Bun\.|globalThis\.)/),
    ).toEqual([])
  })

  it('reads no clock and draws no randomness', async () => {
    expect(await offendingLines(/\b(Date\.now|new Date|Math\.random|crypto\.)/)).toEqual([])
  })
})
