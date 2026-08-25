import { TreeSitterClient } from '@opentui/core';
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getParsers } from '../parsers.generated.js';

/**
 * Runs the real grammars through a real parser worker, because everything that can go wrong here
 * goes wrong at runtime and nowhere else. A grammar built against an older tree-sitter ABI loads and
 * then faults mid-parse; a highlight query written against a different revision of the same grammar
 * fails to compile and the language silently loses its parser — reported as "no parser available",
 * not as an error. Both were observed while choosing these four. Neither is visible to `tsc`, and a
 * mocked client would assert only that we can call a function.
 */

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', 'parsers-config.json'), 'utf8')) as {
  parsers: { filetype: string; aliases?: string[] }[];
};

/** Each sample is chosen to exercise several captures, not just one. */
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
    // The only grammar this repo compiles itself (`pnpm grammars:build-sql`), so it is also the only
    // one where a stale artefact is possible — this is the test that would catch it.
    source: 'SELECT id, COUNT(m.id) AS n\nFROM sessions s\nWHERE s.ended_at IS NULL;\n',
    expect: ['keyword', 'field', 'function.call'],
  },
};

describe('vendored tree-sitter grammars', () => {
  const dataPath = mkdtempSync(join(tmpdir(), 'atlas-grammars-'));
  const client = new TreeSitterClient({ dataPath, initTimeout: 30_000 });
  const failures: string[] = [];
  client.on('error', (error) => failures.push(error));

  afterAll(async () => {
    await client.destroy();
    rmSync(dataPath, { recursive: true, force: true });
  });

  it('vendors every asset the generated parsers reference', async () => {
    const parsers = await getParsers();

    expect(parsers.map((parser) => parser.filetype).sort()).toEqual(
      config.parsers.map((parser) => parser.filetype).sort(),
    );

    for (const parser of parsers) {
      for (const path of [parser.wasm, ...parser.queries.highlights, ...(parser.queries.injections ?? [])]) {
        expect(existsSync(path), `${parser.filetype}: missing ${path}`).toBe(true);
      }
    }
  });

  it('carries the aliases declared in the config through to the parsers', async () => {
    const parsers = await getParsers();

    for (const declared of config.parsers) {
      const parser = parsers.find((candidate) => candidate.filetype === declared.filetype);
      expect(parser?.aliases ?? []).toEqual(declared.aliases ?? []);
    }
  });

  it('highlights every vendored language', async () => {
    await client.initialize();
    for (const parser of await getParsers()) {
      client.addFiletypeParser(parser);
    }

    for (const [filetype, sample] of Object.entries(SAMPLES)) {
      const result = await client.highlightOnce(sample.source, filetype);
      const groups = new Set((result.highlights ?? []).map(([, , group]) => group));

      expect(result.error, `${filetype}: ${result.error}`).toBeUndefined();
      // A missing grammar is a WARNING, not an error — the one failure mode most likely to ship.
      expect(result.warning, `${filetype}: ${result.warning}`).toBeUndefined();
      for (const group of sample.expect) {
        expect([...groups], `${filetype} is missing @${group}`).toContain(group);
      }
    }

    expect(failures).toEqual([]);
  }, 60_000);

  it('covers the languages the samples claim to cover', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(config.parsers.map((parser) => parser.filetype).sort());
  });
});
