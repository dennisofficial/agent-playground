/**
 * message-enforcement — the STRUCTURAL lint half of the hub seam (decision d10). The branded `AgentMessage`
 * type is the compile-time half: it catches "a bare string was handed to a delivery seam". This spec catches
 * the OTHER failure mode the type cannot see — a service standing up a NEW raw delivery path (a hand-built
 * streaming steer, a direct SDK session) that never crosses the brand at all. It scans the backend source tree
 * and fails CI if any `SEALED_DELIVERY_PRIMITIVES` call token appears OUTSIDE `SANCTIONED_SEAM_GLOBS`.
 *
 * Idiomatic to `r6-invariants.spec.ts` (a pure source/structural scan; no DB, Docker, or LLM) and to
 * `prompt-lint.spec.ts` (one `it()` per file so a regression names the exact offender). The single source of
 * truth is `message.ts` — this spec imports its inventories rather than restating them, so widening the seam is
 * a one-line edit there, not here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SANCTIONED_SEAM_GLOBS,
  SEALED_DELIVERY_PRIMITIVES,
  assertEnforcementSeamConfigured,
} from './message';

// `__dirname` is backend/src/app/prompt-kit; the app root is one up, and the seam globs are written relative to
// the backend package root (`src/app/...`), so we rebase each scanned file onto that same coordinate.
const APP_ROOT = join(__dirname, '..');
const BACKEND_ROOT = join(__dirname, '..', '..', '..');

/** Every `.ts` file under `src/app` that is real source (specs/int-tests are excluded — a lint is not a
 *  delivery path, and specs legitimately reference the sealed tokens as fixtures/inventory). */
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
  walk(APP_ROOT);
  return out;
}

/** Path as the seam globs express it (relative to `backend/`, forward-slashed). */
function backendRelative(file: string): string {
  return relative(BACKEND_ROOT, file).split('\\').join('/');
}

/** A `src/app/foo/**` glob matches any file under that prefix; anything else is an exact file path. */
function isSanctioned(relPath: string): boolean {
  return SANCTIONED_SEAM_GLOBS.some((glob) =>
    glob.endsWith('/**')
      ? relPath.startsWith(glob.slice(0, -2))
      : relPath === glob,
  );
}

/** A line that is purely a `//` or `*` comment — a doc-comment mentioning a sealed token is not a call. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/** Non-comment lines of `content` that contain any sealed primitive, with the primitive that hit. */
function sealedHits(
  content: string,
): Array<{ primitive: string; line: string }> {
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
  // One `it` per file that calls a sealed primitive, mirroring prompt-lint: a violation names the exact file
  // (and the offending call) rather than surfacing as a single opaque failure. On the clean tree the only
  // matches are the seam itself (`prompt-kit/message.ts`'s inventory + `engine/engine-core.ts`), both sanctioned.
  if (FILES_WITH_SEALED_CALLS.length === 0) {
    it('found the sealed primitives somewhere in the tree (scan is not mis-scoped)', () => {
      // A zero-match scan means the walk broke or the tokens went stale — never a legitimate green.
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
  // Guards against the test silently passing by mis-scoping: each declared sealed token MUST still appear in a
  // sanctioned file. If a token goes dead (the primitive was renamed) or the seam glob stops resolving, this
  // trips instead of the whole lint quietly matching nothing.
  for (const primitive of SEALED_DELIVERY_PRIMITIVES) {
    it(`${primitive} is present in a sanctioned file`, () => {
      const present = FILES_WITH_SEALED_CALLS.some(
        (f) =>
          isSanctioned(f.rel) && f.hits.some((h) => h.primitive === primitive),
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
