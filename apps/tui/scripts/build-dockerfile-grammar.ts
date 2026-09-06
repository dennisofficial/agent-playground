#!/usr/bin/env bun
/**
 * Builds `src/ui/markdown/grammars/vendor/tree-sitter-dockerfile.wasm`.
 *
 * No published wasm exists: npm's `tree-sitter-dockerfile` is a 0.0.1-security placeholder,
 * and the grammar (camdencheek/tree-sitter-dockerfile) ships no release artefacts, so like
 * SQL this one is compiled here. `CLI_VERSION` must track `@opentui/core`'s web-tree-sitter
 * peer dependency — the failure that pin prevents is a grammar built against one ABI loaded
 * by another. v0.2.0 predates `tree-sitter.json`, which the 0.25 CLI requires, so it is
 * written into the checkout below. The highlights query vendored by `parsers-config.json`
 * is pinned to the same tag, per the same-version rule in that file.
 *
 * Requires Docker (the CLI runs emscripten in a container when `emcc` isn't on PATH) — and
 * only when the wasm is missing, which for a normal checkout is never, because the built
 * artefact is committed.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_VERSION = '0.25.10'
const GRAMMAR_TAG = 'v0.2.0'
const GRAMMAR_REPO = 'https://github.com/camdencheek/tree-sitter-dockerfile.git'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src', 'ui', 'markdown', 'grammars', 'vendor', 'tree-sitter-dockerfile.wasm')

if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`${out} already exists — pass --force to rebuild.`)
  process.exit(0)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

const work = mkdtempSync(join(tmpdir(), 'atlas-dockerfile-grammar-'))
console.log(`building ${GRAMMAR_REPO}@${GRAMMAR_TAG} in ${work}`)

run('git', ['clone', '--depth', '1', '--branch', GRAMMAR_TAG, GRAMMAR_REPO, '.'], work)

writeFileSync(
  join(work, 'tree-sitter.json'),
  JSON.stringify(
    {
      grammars: [
        {
          name: 'dockerfile',
          camelcase: 'Dockerfile',
          scope: 'source.dockerfile',
          'file-types': ['dockerfile'],
        },
      ],
      metadata: { version: GRAMMAR_TAG.slice(1) },
    },
    null,
    2,
  ),
)

run('npx', ['--yes', `tree-sitter-cli@${CLI_VERSION}`, 'build', '--wasm', '.'], work)

mkdirSync(dirname(out), { recursive: true })
copyFileSync(join(work, 'tree-sitter-dockerfile.wasm'), out)
console.log(`wrote ${out} — now run \`bun run grammars:update\` to vendor it into assets/.`)
