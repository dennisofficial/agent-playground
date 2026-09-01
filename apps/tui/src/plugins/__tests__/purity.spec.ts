import { describe, expect, it } from 'bun:test'

import { violationsIn } from '../purity'

const pluginsDir = new URL('..', import.meta.url).pathname

const pureSources = async (): Promise<{ path: string; text: string }[]> => {
  const paths = [...new Bun.Glob('*/pure/**/*.ts').scanSync(pluginsDir)].filter(
    (path) => !path.includes('__tests__'),
  )

  return Promise.all(
    paths.map(async (path) => ({ path, text: await Bun.file(`${pluginsDir}${path}`).text() })),
  )
}

describe('a plugin pure/ directory obeys the same rules core does', () => {
  it('holds nothing impure', async () => {
    const found = (await pureSources()).flatMap(violationsIn)

    expect(found.map((violation) => `${violation.path}: ${violation.rule}: ${violation.line}`)).toEqual(
      [],
    )
  })
})

describe('the rule itself, proven against a fixture rather than against an empty directory', () => {
  const detects = (text: string): readonly string[] =>
    violationsIn({ path: 'github/pure/sample.ts', text }).map((violation) => violation.rule)

  it('passes code that only computes', () => {
    expect(detects("import { z } from 'zod'\nexport const add = (a: number, b: number) => a + b")).toEqual(
      [],
    )
  })

  it('passes a relative import inside its own pure directory', () => {
    expect(detects("import { parse } from './remote-url'")).toEqual([])
  })

  it('passes an import of core, which is itself held pure', () => {
    expect(detects("import type { ThreadId } from '@dltech/atlas-core'")).toEqual([])
  })

  it('catches a clock', () => {
    expect(detects('const at = Date.now()')).toEqual(['reads a clock or draws randomness'])
  })

  it('catches randomness', () => {
    expect(detects('const id = Math.random()')).toEqual(['reads a clock or draws randomness'])
  })

  it('catches a subprocess or a fetch', () => {
    expect(detects("await fetch('https://api.github.com')")).toEqual([
      'reaches for the filesystem, network, database or process',
    ])
    expect(detects('Bun.spawn(["gh", "pr", "view"])')).toEqual([
      'reaches for the filesystem, network, database or process',
    ])
  })

  it('catches an import of the harness, which is the whole point of the rule', () => {
    expect(detects("import { GhPullRequestPort } from '@dltech/atlas-harness'")).toEqual([
      'imports something other than zod or atlas-core',
    ])
  })

  it('catches a relative import that escapes the pure directory', () => {
    expect(detects("import { runGh } from '../gh-adapter'")).toEqual([
      'imports from outside its own pure directory',
    ])
  })
})
