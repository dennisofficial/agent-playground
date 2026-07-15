/**
 * R6 — MULTI-TENANCY INVARIANT TESTS.
 *
 * Cheap structural assertions that confirm the three load-bearing multi-tenancy invariants:
 *
 *   (a) LocalGitService safety flags — every host git invocation runs with hooks and code-executing
 *       filters disabled. The safety flags are prepended unconditionally in `LocalGitService.git()`.
 *
 *   (b) Structural: `ScopingInvestigatorService` is gone; `EngineRunner` is never constructed or
 *       injected directly outside the `ENGINE_RUNNER` / `SANDBOX_PROVIDER` ports (no tenant code runs
 *       host-side through an unguarded seam).
 *
 *   (c) Cross-thread tool-scope denial — covered in `sandbox/tool-bridge.spec.ts` (the R1 gate test
 *       proves both the live stdin/stdout contract AND the per-thread scoping denial, with a real
 *       subprocess). This file references that location; it does NOT duplicate those tests.
 *
 * These tests require no database, no Docker, no LLM key — they are pure source/structural assertions.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname);
const LOCAL_GIT_SRC = join(SRC, 'git', 'local-git.service.ts');

// ── (a) LocalGitService safety flags ─────────────────────────────────────────────────────────────

describe('R6 invariant (a): LocalGitService host-git safety flags', () => {
  /**
   * The host-git policy: every git invocation on the host runs with hooks and code-executing filters
   * disabled so tenant-repo hooks never execute on the host.  The flags are prepended inside the
   * private `git()` method, so even a future caller that forgets to add them is protected.
   *
   * We assert the flags are present in the source rather than spawning real git processes so this
   * test has zero side-effects and runs offline.
   */
  const src = readFileSync(LOCAL_GIT_SRC, 'utf8');

  it('source includes core.hooksPath=/dev/null flag', () => {
    expect(src).toContain('core.hooksPath=/dev/null');
  });

  it('source includes core.fsmonitor=false flag', () => {
    expect(src).toContain('core.fsmonitor=false');
  });

  it('source includes filter.lfs.clean= disable flag', () => {
    expect(src).toContain('filter.lfs.clean=');
  });

  it('source includes filter.lfs.smudge= disable flag', () => {
    expect(src).toContain('filter.lfs.smudge=');
  });

  it('source includes filter.lfs.process= disable flag', () => {
    expect(src).toContain('filter.lfs.process=');
  });

  it('source includes filter.lfs.required=false flag', () => {
    expect(src).toContain('filter.lfs.required=false');
  });

  it('all flags are prepended before the subcommand args (the safetyFlags array precedes ...args)', () => {
    // The canonical shape in source: `[...safetyFlags, ...args]` — flags come first.
    expect(src).toContain('[...safetyFlags, ...args]');
  });

  it('GIT_CONFIG_NOSYSTEM=1 env var is set (belt-and-suspenders system-config disable)', () => {
    expect(src).toContain('GIT_CONFIG_NOSYSTEM');
  });
});

// ── (b) Structural: ScopingInvestigatorService is gone; EngineRunner not injected outside ports ──

describe('R6 invariant (b): ScopingInvestigatorService deleted; EngineRunner only via ports', () => {
  /**
   * ScopingInvestigatorService was the host-side read-only engine pass that ran planning turns on
   * the host, bypassing `ENGINE_RUNNER`/`SANDBOX_PROVIDER`.  R3 deleted it.  Verify it is truly gone.
   */
  it('scoping-investigator.service.ts does NOT exist in app/brain/', () => {
    const path = join(SRC, 'brain', 'scoping-investigator.service.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('no NON-TEST source file in app/ imports ScopingInvestigatorService', () => {
    const matches = grepAppSrc(/ScopingInvestigatorService/, [
      '.spec.ts',
      '.int.test.ts',
    ]);
    // Only comments are allowed (the service is mentioned in JSDoc of its successor).
    const nonComment = matches.filter((line) => {
      // The line format is `path: content` — extract just the content part.
      const content = line.split(': ').slice(1).join(': ').trim();
      return !content.startsWith('*') && !content.startsWith('//');
    });
    expect(nonComment).toHaveLength(0);
  });

  /**
   * EngineRunner (the host-side in-process concrete class) is the seam that would allow tenant code
   * to run on the host bypassing the sandbox.  It MUST NOT be imported in brain/ or driver/ service
   * files — those modules must go through the `ENGINE_RUNNER` port token.
   *
   * Allowed:
   *   - `DockerEngineRunner` (the sandboxed runner; safe to inject directly in brain/ as it execs
   *     turns inside the tenant's sandbox container, not on the host).
   *   - `EngineRunnerPort` (the interface/type — carries no runtime code).
   *   - The `engine/` and `sandbox/` subdirs (EngineRunner is defined and wired there).
   *   - Test / int-test files (used to build stubs).
   *
   * Violation pattern: `import { EngineRunner }` (the concrete host class) in a brain or driver
   * service file.
   */
  it('the concrete host EngineRunner class is NOT imported in brain/ service files', () => {
    // Pattern: `EngineRunner` as a named import (but NOT `DockerEngineRunner` / `EngineRunnerPort`)
    const violations = grepAppDir(
      'brain',
      /import[^;]*\bEngineRunner\b(?!Port)/,
      ['.spec.ts', '.int.test.ts'],
    ).filter((line) => {
      // Allow DockerEngineRunner imports — it execs turns inside the sandbox container.
      const content = line.split(': ').slice(1).join(': ');
      return !content.includes('DockerEngineRunner');
    });
    expect(violations).toHaveLength(0);
  });

  it('the concrete host EngineRunner class is NOT imported in driver/ service files', () => {
    const violations = grepAppDir(
      'driver',
      /import[^;]*\bEngineRunner\b(?!Port)/,
      ['.spec.ts', '.int.test.ts'],
    ).filter((line) => {
      const content = line.split(': ').slice(1).join(': ');
      return !content.includes('DockerEngineRunner');
    });
    expect(violations).toHaveLength(0);
  });

  it('runner/ files use EngineRunnerPort (the interface), not the host EngineRunner class directly', () => {
    // runner/ should import EngineRunnerPort (the interface) or ENGINE_RUNNER (the token), never the
    // raw EngineRunner class (which would bypass the sandbox abstraction).
    const violations = grepAppDir(
      'runner',
      /import[^;]*\bEngineRunner\b(?!Port)/,
      ['.spec.ts', '.int.test.ts'],
    ).filter((line) => {
      const content = line.split(': ').slice(1).join(': ');
      return !content.includes('DockerEngineRunner');
    });
    expect(violations).toHaveLength(0);
  });
});

// ── (c) Cross-thread scope denial ────────────────────────────────────────────────────────────────

describe('R6 invariant (c): cross-thread tool-scope denial (reference)', () => {
  /**
   * The tool bridge enforces per-thread scope in the shared `dispatchToolRequest` (engine/tool-bridge-host.ts),
   * called by `RedisEngineRunner.consumeTools` — a tool_request whose args name a DIFFERENT thread is denied
   * with a `tool_error` scope violation. (The former pipe `ToolBridgeHost` + its subprocess spec were removed
   * at the Redis cutover, ADR 0001; the dispatch + its scope guard remain.)
   */
  it('dispatchToolRequest source enforces per-thread scope before dispatching any tool', () => {
    const src = readFileSync(
      join(SRC, 'engine', 'tool-bridge-host.ts'),
      'utf8',
    );
    // The guard: for a THREAD-SCOPED tool, if args includes a jobId field it must match the owning thread.
    expect(src).toContain('Thread scope violation');
    expect(src).toContain("args['jobId'] !== bridge.jobId");
    // The repo-level atlas-prod diagnostics tools are EXEMPT (they take an explicit jobId by design to
    // inspect any job in the repo), so the guard must skip them — assert the exemption stays wired.
    expect(src).toContain('CROSS_JOB_TOOL_NAMES');
    expect(src).toContain('!CROSS_JOB_TOOL_NAMES.has(name)');
  });

  it('RedisEngineRunner dispatches host tools through dispatchToolRequest (scope-enforced path)', () => {
    const src = readFileSync(
      join(SRC, 'sandbox', 'redis-engine-runner.ts'),
      'utf8',
    );
    expect(src).toContain('dispatchToolRequest');
  });
});

// Note: the former (d) "web surface flag-gated" invariant was removed when Atlas collapsed to a single
// web surface — web is the sole product surface, so its control endpoints are always mounted (no
// surface-gating to assert). The host-git-safety / no-host-EngineRunner / cross-thread-scope invariants
// (a)/(b)/(c) above are unaffected.

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Grep all TypeScript source files under `app/` (non-recursively in a subdirectory when dir is
 * given) for lines matching `pattern`, excluding files whose path ends with one of `excludeSuffixes`.
 * Returns an array of `file:line` strings for the matching lines.
 */
function grepAppSrc(pattern: RegExp, excludeSuffixes: string[] = []): string[] {
  return grepAppDir('', pattern, excludeSuffixes);
}

function grepAppDir(
  subdir: string,
  pattern: RegExp,
  excludeSuffixes: string[] = [],
): string[] {
  const {
    readdirSync,
    statSync,
    readFileSync: rf,
  } = require('node:fs') as typeof import('node:fs');
  const targetDir = subdir ? join(SRC, subdir) : SRC;

  const hits: string[] = [];

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts')) {
        if (excludeSuffixes.some((s) => full.endsWith(s))) continue;
        let content: string;
        try {
          content = rf(full, 'utf8');
        } catch {
          continue;
        }
        for (const line of content.split('\n')) {
          if (pattern.test(line)) {
            hits.push(`${full}: ${line.trim()}`);
          }
        }
      }
    }
  }

  walk(targetDir);
  return hits;
}
