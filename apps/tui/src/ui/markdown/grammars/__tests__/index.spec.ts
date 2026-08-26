import { TreeSitterClient } from '@opentui/core'
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getParsers } from '../parsers.generated'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(readFileSync(join(here, '..', 'parsers-config.json'), 'utf8')) as {
  parsers: { filetype: string; aliases?: string[] }[]
}

const SAMPLES: Record<string, { source: string; expect: string[] }> = {
  python: {
    source: 'import os\n\n\ndef greet(name: str) -> str:\n    # hello\n    return f"hi {name}"\n',
    expect: ['keyword', 'comment', 'string', 'function'],
  },
  bash: {
    source: '#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.txt; do\n  echo "$f"\ndone\n',
    expect: ['comment', 'keyword', 'string'],
  },
  json: {
    source: '{\n  "name": "atlas",\n  "count": 3,\n  "ok": true\n}\n',
    expect: ['string.special.key', 'string', 'number'],
  },
  yaml: {
    source: 'name: atlas\nitems:\n  - one\n  - two\nenabled: true\n',
    expect: ['property', 'string', 'boolean'],
  },
  css: {
    source: 'a.link {\n  color: #7cbdff;\n  font-family: "SF Mono", monospace;\n}\n',
    expect: ['tag', 'property', 'string'],
  },
  sql: {
    source: 'SELECT id, COUNT(m.id) AS n\nFROM sessions s\nWHERE s.ended_at IS NULL;\n',
    expect: ['keyword', 'field', 'function.call'],
  },
  java: {
    source:
      'package demo;\n\n// hello\npublic class Greeter {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}\n',
    expect: ['keyword', 'comment', 'string', 'type', 'function.method'],
  },
  go: {
    source:
      'package main\n\nimport "fmt"\n\n// hello\nfunc greet(name string) string {\n  return fmt.Sprintf("hi %s", name)\n}\n',
    expect: ['keyword', 'comment', 'string', 'type', 'function'],
  },
  rust: {
    source:
      'use std::fmt;\n\n// hello\nfn greet(name: &str) -> String {\n  let n: u32 = 1;\n  format!("hi {name} {n}")\n}\n',
    expect: ['keyword', 'comment', 'string', 'type', 'function.macro'],
  },
  c: {
    source:
      '#include <stdio.h>\n\n// hello\nint add(int a, int b) {\n  return a + b;\n}\n\nint main(void) {\n  printf("%d\\n", add(5, 3));\n  return 0;\n}\n',
    expect: ['keyword', 'comment', 'string', 'type', 'function'],
  },
  cpp: {
    source:
      '#include <string>\n\n// hello\nnamespace demo {\nstd::string greet(const std::string &name) {\n  return "hi " + name;\n}\n}\n',
    expect: ['keyword', 'comment', 'string', 'type', 'function'],
  },
  javascript: {
    source:
      'import fs from "fs";\n\n// hello\nexport const greet = (name) => {\n  const n = 1;\n  return `hi ${name} ${n}`;\n};\n',
    expect: ['keyword', 'comment', 'string', 'number', 'function'],
  },
  typescript: {
    source:
      'import type { Stats } from "fs";\n\n// hello\ninterface User {\n  id: number;\n}\nexport const greet = (u: User): string => `hi ${u.id}`;\n',
    expect: ['keyword', 'comment', 'string', 'type', 'type.builtin', 'variable.parameter'],
  },
  typescriptreact: {
    source:
      'interface Props {\n  name: string;\n}\n\n// hello\nexport const Hello = ({ name }: Props) => (\n  <div className="greeting">Hello, {name}!</div>\n);\n',
    expect: ['keyword', 'comment', 'string', 'type', 'tag', 'attribute'],
  },
  php: {
    source:
      '<?php\n\n// hello\nfunction add(int $a, int $b): int {\n  return $a + $b;\n}\n\necho add(5, 3);\n',
    expect: ['tag', 'keyword', 'comment', 'variable', 'type.builtin', 'function'],
  },
  lua: {
    source:
      '-- hello\nlocal function add(a, b)\n  return a + b\nend\n\nlocal Calculator = {}\nfunction Calculator:multiply(x, y)\n  return x * y\nend\n\nprint(add(5, 3))\n',
    expect: ['comment', 'keyword', 'function', 'number', 'variable'],
  },
  toml: {
    source:
      '# hello\n[package]\nname = "atlas"\nversion = "0.1.0"\nenabled = true\ncount = 3\n\n[deps.zod]\nversion = "3.0"\n',
    expect: ['comment', 'property', 'string', 'boolean', 'number', 'type'],
  },
  html: {
    source:
      '<!DOCTYPE html>\n<html lang="en">\n  <!-- hello -->\n  <body>\n    <h1 class="title">Hello</h1>\n  </body>\n</html>\n',
    expect: ['tag', 'attribute', 'string', 'comment', 'constant'],
  },
}

describe('vendored tree-sitter grammars', () => {
  const dataPath = mkdtempSync(join(tmpdir(), 'atlas-grammars-'))
  const client = new TreeSitterClient({ dataPath, initTimeout: 30_000 })
  const failures: string[] = []
  client.on('error', (error) => failures.push(error))

  afterAll(async () => {
    await client.destroy()
    rmSync(dataPath, { recursive: true, force: true })
  })

  it('vendors every asset the generated parsers reference', async () => {
    const parsers = await getParsers()

    expect(parsers.map((parser) => parser.filetype).sort()).toEqual(
      config.parsers.map((parser) => parser.filetype).sort(),
    )

    for (const parser of parsers) {
      const referenced = [
        parser.wasm,
        ...parser.queries.highlights,
        ...(parser.queries.injections ?? []),
      ]
      for (const path of referenced) {
        expect(existsSync(path), `${parser.filetype}: missing ${path}`).toBe(true)
      }
    }
  })

  it('carries the aliases declared in the config through to the parsers', async () => {
    const parsers = await getParsers()

    for (const declared of config.parsers) {
      const parser = parsers.find((candidate) => candidate.filetype === declared.filetype)
      expect(parser?.aliases ?? []).toEqual(declared.aliases ?? [])
    }
  })

  it('highlights every vendored language', async () => {
    await client.initialize()
    for (const parser of await getParsers()) {
      client.addFiletypeParser(parser)
    }

    for (const [filetype, sample] of Object.entries(SAMPLES)) {
      const result = await client.highlightOnce(sample.source, filetype)
      const groups = new Set((result.highlights ?? []).map(([, , group]) => group))

      expect(result.error, `${filetype}: ${result.error}`).toBeUndefined()
      expect(result.warning, `${filetype}: ${result.warning}`).toBeUndefined()
      for (const group of sample.expect) {
        expect([...groups], `${filetype} is missing @${group}`).toContain(group)
      }
    }

    expect(failures).toEqual([])
  }, 60_000)

  it('leaves a lowercase binding plain rather than colouring it a constant', async () => {
    await client.initialize()
    for (const parser of await getParsers()) {
      client.addFiletypeParser(parser)
    }

    const source = 'const users = 1;'
    const start = source.indexOf('users')

    for (const filetype of ['typescript', 'typescriptreact', 'javascript']) {
      const result = await client.highlightOnce(source, filetype)
      const onUsers = (result.highlights ?? [])
        .filter(([from]) => from === start)
        .map(([, , group]) => group)

      expect(onUsers, `${filetype} miscaptured a lowercase binding`).not.toContain('constant')
      expect(onUsers, `${filetype} miscaptured a lowercase binding`).not.toContain('type')
    }
  }, 60_000)

  it('covers the languages the samples claim to cover', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      config.parsers.map((parser) => parser.filetype).sort(),
    )
  })
})
