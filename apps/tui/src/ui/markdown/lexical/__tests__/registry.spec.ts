import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LEXICAL_LANGUAGES } from '../languages/index'
import { lexicalKeys, lexicalScannerFor } from '../registry'

const here = dirname(fileURLToPath(import.meta.url))
const grammars = JSON.parse(
  readFileSync(join(here, '..', '..', 'grammars', 'parsers-config.json'), 'utf8'),
) as { parsers: { filetype: string; aliases?: string[] }[] }

// OpenTUI ships these parsers itself; `parsers-config.json` never names them, so a lexical spec
// claiming one would silently win over a real grammar.
const OPENTUI_BUNDLED = ['markdown', 'markdown_inline', 'zig']

const treeSitterKeys = new Set([
  ...OPENTUI_BUNDLED,
  ...grammars.parsers.flatMap((parser) => [parser.filetype, ...(parser.aliases ?? [])]),
])

const languagesDir = join(here, '..', 'languages')

describe('lexical language registry', () => {
  it('registers every language file in the directory', () => {
    const onDisk = readdirSync(languagesDir)
      .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
      .map((name) => name.replace(/\.ts$/, ''))
      .sort()

    expect(LEXICAL_LANGUAGES.map((spec) => spec.filetype).sort()).toEqual(onDisk)
  })

  it('has a test for every language', () => {
    const tested = readdirSync(join(languagesDir, '__tests__'))
      .filter((name) => name.endsWith('.spec.ts'))
      .map((name) => name.replace(/\.spec\.ts$/, ''))
      .sort()

    expect(tested).toEqual(LEXICAL_LANGUAGES.map((spec) => spec.filetype).sort())
  })

  it('claims no language a tree-sitter grammar already parses', () => {
    const stolen = lexicalKeys().filter((key) => treeSitterKeys.has(key))
    expect(stolen).toEqual([])
  })

  it('resolves every declared filetype and alias to a scanner', () => {
    for (const key of lexicalKeys()) {
      expect(lexicalScannerFor(key), `"${key}" resolves to no scanner`).not.toBeNull()
    }
  })

  it('declines a language it does not know', () => {
    expect(lexicalScannerFor('not-a-language')).toBeNull()
  })

  it('resolves a language case-insensitively', () => {
    for (const spec of LEXICAL_LANGUAGES) {
      expect(lexicalScannerFor(spec.filetype.toUpperCase())).not.toBeNull()
    }
  })

  it('gives every language something to colour', () => {
    for (const spec of LEXICAL_LANGUAGES) {
      const wordCount = Object.values(spec.words ?? {}).flat().length
      expect(wordCount + (spec.rules?.length ?? 0), `${spec.filetype} colours nothing`).toBeGreaterThan(0)
    }
  })

  it('gives every language a comment form and a string form', () => {
    for (const spec of LEXICAL_LANGUAGES) {
      const groups = (spec.rules ?? []).map((rule) => rule.group)
      expect(groups, `${spec.filetype} has no comment rule`).toContain('comment')
      expect(groups, `${spec.filetype} has no string rule`).toContain('string')
    }
  })
})
