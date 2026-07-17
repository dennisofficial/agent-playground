
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const SHARED_SRC = join(SRC, '..', 'shared');
const LOCAL_GIT_SRC = join(SRC, 'git', 'local-git.service.ts');


describe('R6 invariant (a): LocalGitService host-git safety flags', () => {
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
    expect(src).toContain('[...safetyFlags, ...args]');
  });

  it('GIT_CONFIG_NOSYSTEM=1 env var is set (belt-and-suspenders system-config disable)', () => {
    expect(src).toContain('GIT_CONFIG_NOSYSTEM');
  });
});


describe('R6 invariant (b): ScopingInvestigatorService deleted; EngineRunner only via ports', () => {
  it('scoping-investigator.service.ts does NOT exist in app/brain/', () => {
    const path = join(SRC, 'brain', 'scoping-investigator.service.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('no NON-TEST source file in app/ imports ScopingInvestigatorService', () => {
    const matches = grepAppSrc(/ScopingInvestigatorService/, ['.spec.ts', '.int.test.ts']);
    const nonComment = matches.filter((line) => {
      const content = line.split(': ').slice(1).join(': ').trim();
      return !content.startsWith('*') && !content.startsWith('//');
    });
    expect(nonComment).toHaveLength(0);
  });

  it('the concrete host EngineRunner class is NOT imported in brain/ service files', () => {
    const violations = grepAppDir('brain', /import[^;]*\bEngineRunner\b(?!Port)/, [
      '.spec.ts',
      '.int.test.ts',
    ]).filter((line) => {
      const content = line.split(': ').slice(1).join(': ');
      return !content.includes('DockerEngineRunner');
    });
    expect(violations).toHaveLength(0);
  });

  it('the concrete host EngineRunner class is NOT imported in driver/ service files', () => {
    const violations = grepAppDir('driver', /import[^;]*\bEngineRunner\b(?!Port)/, [
      '.spec.ts',
      '.int.test.ts',
    ]).filter((line) => {
      const content = line.split(': ').slice(1).join(': ');
      return !content.includes('DockerEngineRunner');
    });
    expect(violations).toHaveLength(0);
  });

  it('runner/ files use EngineRunnerPort (the interface), not the host EngineRunner class directly', () => {
    const violations = grepAppDir('runner', /import[^;]*\bEngineRunner\b(?!Port)/, [
      '.spec.ts',
      '.int.test.ts',
    ]).filter((line) => {
      const content = line.split(': ').slice(1).join(': ');
      return !content.includes('DockerEngineRunner');
    });
    expect(violations).toHaveLength(0);
  });
});


describe('R6 invariant (c): cross-thread tool-scope denial (reference)', () => {
  it('dispatchToolRequest source enforces per-thread scope before dispatching any tool', () => {
    const src = readFileSync(join(SHARED_SRC, 'engine', 'tool-bridge-host.ts'), 'utf8');
    expect(src).toContain('Thread scope violation');
    expect(src).toContain("args['jobId'] !== bridge.jobId");
    expect(src).toContain('CROSS_JOB_TOOL_NAMES');
    expect(src).toContain('!CROSS_JOB_TOOL_NAMES.has(name)');
  });

  it('RedisEngineRunner dispatches host tools through dispatchToolRequest (scope-enforced path)', () => {
    const src = readFileSync(join(SRC, 'sandbox', 'redis-engine-runner.ts'), 'utf8');
    expect(src).toContain('dispatchToolRequest');
  });
});



function grepAppSrc(pattern: RegExp, excludeSuffixes: string[] = []): string[] {
  return grepAppDir('', pattern, excludeSuffixes);
}

function grepAppDir(subdir: string, pattern: RegExp, excludeSuffixes: string[] = []): string[] {
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
