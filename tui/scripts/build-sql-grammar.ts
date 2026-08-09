#!/usr/bin/env node
/**
 * Builds `grammars/vendor/tree-sitter-sql.wasm`, the one grammar this app compiles itself.
 *
 * Every other entry in `parsers-config.json` is a CDN URL to a `.wasm` the grammar's own maintainers
 * published. SQL has none: `@derekstride/tree-sitter-sql` — the grammar nvim, helix and zed all use
 * — ships its `grammar.js`, `src/parser.c` and queries to npm but no wasm, its GitHub releases carry
 * only a source tarball, and `tree-sitter-wasms` (the third-party bundle) has no SQL at all and is
 * still the 0.20-built package whose YAML grammar crashes the parser worker.
 *
 * So the choice is "no SQL highlighting" or "build it here". This builds it — and building it HERE,
 * pinned to the CLI that matches the runtime, is what the maintainer-built rule was protecting in
 * the first place: the failure it warns about is a grammar compiled against one ABI being loaded by
 * another. `CLI_VERSION` below must track `@opentui/core`'s `web-tree-sitter` peer dependency.
 *
 * Requires Docker (the CLI runs emscripten in a container when `emcc` isn't on PATH) — and only when
 * the wasm is missing, which for a normal checkout is never, because the built artefact is committed.
 *
 * Verified after building: the wasm loads under web-tree-sitter 0.25.10, parses a multi-join SELECT
 * without an error node, and its `highlights.scm` compiles against it.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must match `@opentui/core`'s `web-tree-sitter` peer dependency — see the note above. */
const CLI_VERSION = '0.25.10';
const GRAMMAR = '@derekstride/tree-sitter-sql@0.3.11';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'ui', 'markdown', 'grammars', 'vendor', 'tree-sitter-sql.wasm');

if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`${out} already exists — pass --force to rebuild.`);
  process.exit(0);
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

const work = mkdtempSync(join(tmpdir(), 'atlas-sql-grammar-'));
console.log(`building ${GRAMMAR} in ${work}`);

run('npm', ['pack', GRAMMAR], work);
run('sh', ['-c', 'tar -xzf *.tgz'], work);

const pkg = join(work, 'package');
// The 0.3.11 tarball predates `tree-sitter.json`, which the 0.25 CLI requires before it will build.
// Only the grammar name is load-bearing; the rest is metadata the CLI wants present.
writeFileSync(
  join(pkg, 'tree-sitter.json'),
  JSON.stringify(
    {
      grammars: [{ name: 'sql', camelcase: 'Sql', scope: 'source.sql', 'file-types': ['sql'] }],
      metadata: { version: '0.3.11' },
    },
    null,
    2,
  ),
);

run('npx', ['--yes', `tree-sitter-cli@${CLI_VERSION}`, 'build', '--wasm', '.'], pkg);

mkdirSync(dirname(out), { recursive: true });
copyFileSync(join(pkg, 'tree-sitter-sql.wasm'), out);
console.log(`wrote ${out} — now run \`pnpm grammars:update\` to vendor it into assets/.`);
