import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertEnforcementSeamConfigured,
  SANCTIONED_SEAM_GLOBS,
  SEALED_DELIVERY_PRIMITIVES,
} from './message';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOTS = [join(BACKEND_ROOT, 'src/app'), join(BACKEND_ROOT, 'src/shared')];

function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full);
      } else if (
        entry.endsWith('.ts') &&
        !entry.endsWith('.spec.ts') &&
        !entry.endsWith('.int.test.ts')
      ) {
        out.push(full);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return out;
}

function backendRelative(file: string): string {
  return relative(BACKEND_ROOT, file).split('\\').join('/');
}

function isSanctioned(relPath: string): boolean {
  return SANCTIONED_SEAM_GLOBS.some((glob) =>
    glob.endsWith('/**') ? relPath.startsWith(glob.slice(0, -2)) : relPath === glob,
  );
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function sealedHits(content: string): Array<{ primitive: string; line: string }> {
  const hits: Array<{ primitive: string; line: string }> = [];
  for (const line of content.split('\n')) {
    if (isCommentLine(line)) continue;
    for (const primitive of SEALED_DELIVERY_PRIMITIVES) {
      if (line.includes(primitive)) hits.push({ primitive, line: line.trim() });
    }
  }
  return hits;
}

const SOURCE_FILES = collectSourceFiles();
const FILES_WITH_SEALED_CALLS = SOURCE_FILES.map((f) => ({
  rel: backendRelative(f),
  hits: sealedHits(readFileSync(f, 'utf8')),
})).filter((f) => f.hits.length > 0);

describe('message-enforcement / every sealed delivery primitive lives inside the sanctioned seam', () => {
  if (FILES_WITH_SEALED_CALLS.length === 0) {
    it('found the sealed primitives somewhere in the tree (scan is not mis-scoped)', () => {
      expect.fail(
        'no file contained any SEALED_DELIVERY_PRIMITIVES — the source scan is mis-scoped or the tokens are dead',
      );
    });
  }
  for (const { rel, hits } of FILES_WITH_SEALED_CALLS) {
    it(rel, () => {
      expect(
        isSanctioned(rel),
        `${rel} calls a sealed delivery primitive (${hits
          .map((h) => h.primitive)
          .join(
            ', ',
          )}) but is NOT in SANCTIONED_SEAM_GLOBS. Route the message through a prompt-kit factory — do not hand-build a delivery path here.\n  ${hits
          .map((h) => `${h.primitive} → ${h.line}`)
          .join('\n  ')}`,
      ).toBe(true);
    });
  }
});

describe('message-enforcement / inverse coverage — the seam actually exercises every sealed token', () => {
  for (const primitive of SEALED_DELIVERY_PRIMITIVES) {
    it(`${primitive} is present in a sanctioned file`, () => {
      const present = FILES_WITH_SEALED_CALLS.some(
        (f) => isSanctioned(f.rel) && f.hits.some((h) => h.primitive === primitive),
      );
      expect(
        present,
        `sealed token ${JSON.stringify(primitive)} appears in NO sanctioned file — it is dead or the seam glob no longer resolves`,
      ).toBe(true);
    });
  }
});

describe('message-enforcement / the enforcement config itself is non-degenerate', () => {
  it('assertEnforcementSeamConfigured passes and the inventories are non-empty', () => {
    expect(() => assertEnforcementSeamConfigured()).not.toThrow();
    expect(SEALED_DELIVERY_PRIMITIVES.length).toBeGreaterThan(0);
    expect(SANCTIONED_SEAM_GLOBS.length).toBeGreaterThan(0);
  });
});
