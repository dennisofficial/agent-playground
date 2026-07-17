import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectRepoManifests } from '../manifest-detect';

describe('detectRepoManifests', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-manifest-'));
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'go.mod'), 'module x');
    writeFileSync(join(dir, 'README.md'), '# x'); // not a manifest
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'requirements.txt'), 'flask'); // nested — root-only scan ignores it
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('detects known root-level manifests only, sorted', () => {
    expect(detectRepoManifests(dir)).toEqual(['go.mod', 'package.json']);
  });

  it('returns [] for a missing/unreadable directory (never throws)', () => {
    expect(detectRepoManifests(join(dir, 'does-not-exist'))).toEqual([]);
  });
});
