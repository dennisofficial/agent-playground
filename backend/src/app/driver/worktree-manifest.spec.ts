import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorktreeManifest } from './worktree-manifest';

describe('loadWorktreeManifest', () => {
  let wt: string;

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'atlas-manifest-'));
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  function writeManifest(content: string): void {
    mkdirSync(join(wt, '.atlas'), { recursive: true });
    writeFileSync(join(wt, '.atlas', 'worktree.json'), content);
  }

  it('returns an empty manifest (no warnings) when the file is absent', () => {
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest).toEqual({ secrets: [], mounts: [], seed: [] });
    expect(warnings).toEqual([]);
  });

  it('parses a well-formed manifest', () => {
    writeManifest(
      JSON.stringify({
        secrets: [{ path: '.env.keys', from: 'dotenvxPrivateKeys' }],
        mounts: [
          { path: '.cocoindex', mode: 'per-thread' },
          { path: 'reference', mode: 'shared-ro' },
        ],
        seed: ['.env.local'],
      }),
    );
    const { manifest } = loadWorktreeManifest(wt);
    expect(manifest.secrets).toEqual([{ path: '.env.keys', from: 'dotenvxPrivateKeys' }]);
    expect(manifest.mounts).toEqual([
      { path: '.cocoindex', mode: 'per-thread' },
      { path: 'reference', mode: 'shared-ro' },
    ]);
    expect(manifest.seed).toEqual(['.env.local']);
  });

  it('defaults an unknown/absent mount mode to per-thread (with a warning for unknown)', () => {
    writeManifest(JSON.stringify({ mounts: [{ path: 'a' }, { path: 'b', mode: 'bogus' }] }));
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest.mounts).toEqual([
      { path: 'a', mode: 'per-thread' },
      { path: 'b', mode: 'per-thread' },
    ]);
    expect(warnings.some((w) => w.includes('unknown mode'))).toBe(true);
  });

  it('drops malformed entries but keeps valid ones', () => {
    writeManifest(
      JSON.stringify({
        secrets: [{ path: '.env.keys', from: 'k' }, { path: '.bad' }, { from: 'no-path' }],
        seed: ['.ok', 42, ''],
      }),
    );
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest.secrets).toEqual([{ path: '.env.keys', from: 'k' }]);
    expect(manifest.seed).toEqual(['.ok']);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('drops reserved (system-managed) mount paths so they cannot collide with a system bind', () => {
    // `.pnpm-store` is bound by the system at /workspace/.pnpm-store; a manifest mount there would make
    // Docker hard-fail container creation ("Duplicate mount point") and wedge every turn on the thread.
    writeManifest(
      JSON.stringify({
        mounts: [
          { path: '.pnpm-store', mode: 'per-thread' },
          { path: './.pnpm-store/', mode: 'per-thread' },
          { path: '.next/cache', mode: 'per-thread' },
        ],
      }),
    );
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest.mounts).toEqual([{ path: '.next/cache', mode: 'per-thread' }]);
    expect(warnings.filter((w) => w.includes('auto-managed')).length).toBe(2);
  });

  it('ignores a manifest that exceeds the size limit', () => {
    writeManifest(JSON.stringify({ seed: ['x'.repeat(70 * 1024)] }));
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest.seed).toEqual([]);
    expect(warnings[0]).toMatch(/exceeds/);
  });

  it('caps an over-long array and warns', () => {
    writeManifest(JSON.stringify({ seed: Array.from({ length: 250 }, (_, i) => `f${i}`) }));
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest.seed.length).toBe(100);
    expect(warnings.some((w) => w.includes('exceeds'))).toBe(true);
  });

  it('returns empty + a warning on invalid JSON', () => {
    writeManifest('{ not json');
    const { manifest, warnings } = loadWorktreeManifest(wt);
    expect(manifest).toEqual({ secrets: [], mounts: [], seed: [] });
    expect(warnings[0]).toMatch(/unreadable/);
  });
});
