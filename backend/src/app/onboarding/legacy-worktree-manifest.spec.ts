import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLegacyManifestFile } from './legacy-worktree-manifest';

describe('loadLegacyManifestFile', () => {
  let wt: string;

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'atlas-manifest-'));
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  function writeManifest(content: string): void {
    writeFileSync(join(wt, 'atlas.json'), content);
  }

  function writeLegacyManifest(content: string): void {
    mkdirSync(join(wt, '.atlas'), { recursive: true });
    writeFileSync(join(wt, '.atlas', 'worktree.json'), content);
  }

  it('returns an empty manifest (no warnings) when the file is absent', () => {
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest).toEqual({ mounts: [] });
    expect(warnings).toEqual([]);
  });

  it('parses a well-formed manifest (incl. shared-rw); a legacy seed[] is ignored', () => {
    writeManifest(
      JSON.stringify({
        mounts: [
          { path: '.venv', mode: 'per-thread' },
          { path: 'reference', mode: 'shared-ro' },
          { path: '.gcloud', mode: 'shared-rw' },
        ],
        seed: ['.env.local'],
      }),
    );
    const { manifest } = loadLegacyManifestFile(wt);
    expect(manifest).toEqual({
      mounts: [
        { path: '.venv', mode: 'per-thread' },
        { path: 'reference', mode: 'shared-ro' },
        { path: '.gcloud', mode: 'shared-rw' },
      ],
    });
  });

  it('reads the legacy .atlas/worktree.json when atlas.json is absent', () => {
    writeLegacyManifest(JSON.stringify({ mounts: [{ path: 'reference', mode: 'shared-ro' }] }));
    const { manifest } = loadLegacyManifestFile(wt);
    expect(manifest.mounts).toEqual([{ path: 'reference', mode: 'shared-ro' }]);
  });

  it('prefers atlas.json over the legacy path when both exist', () => {
    writeLegacyManifest(JSON.stringify({ mounts: [{ path: 'legacy', mode: 'per-thread' }] }));
    writeManifest(JSON.stringify({ mounts: [{ path: 'current', mode: 'per-thread' }] }));
    expect(loadLegacyManifestFile(wt).manifest.mounts).toEqual([{ path: 'current', mode: 'per-thread' }]);
  });

  it('defaults an unknown/absent mount mode to per-thread (with a warning for unknown)', () => {
    writeManifest(JSON.stringify({ mounts: [{ path: 'a' }, { path: 'b', mode: 'bogus' }] }));
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest.mounts).toEqual([
      { path: 'a', mode: 'per-thread' },
      { path: 'b', mode: 'per-thread' },
    ]);
    expect(warnings.some((w) => w.includes('unknown mode'))).toBe(true);
  });

  it('drops malformed entries but keeps valid ones', () => {
    writeManifest(
      JSON.stringify({
        mounts: [{ path: '.venv', mode: 'per-thread' }, { mode: 'shared-ro' }],
      }),
    );
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest.mounts).toEqual([{ path: '.venv', mode: 'per-thread' }]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('drops reserved (system-managed) mount paths so they cannot collide with a system bind', () => {
    // `.pnpm-store` is a system-managed cache (now bound under /.atlas, outside the worktree entirely) —
    // a repo has no legitimate reason to mount a package cache into its own worktree, so it stays reserved.
    writeManifest(
      JSON.stringify({
        mounts: [
          { path: '.pnpm-store', mode: 'per-thread' },
          { path: './.pnpm-store/', mode: 'per-thread' },
          { path: '.next/cache', mode: 'per-thread' },
        ],
      }),
    );
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest.mounts).toEqual([{ path: '.next/cache', mode: 'per-thread' }]);
    expect(warnings.filter((w) => w.includes('auto-managed')).length).toBe(2);
  });

  it('drops ABSOLUTE (external) mount paths — a committed file may not introduce external mounts', () => {
    // External mounts (absolute container paths) are a privileged capability reserved for Atlas's validated
    // write_workspace_config calls; a repo-committed legacy file must never gain it.
    writeManifest(
      JSON.stringify({
        mounts: [
          { path: '/root/.config/gcloud', mode: 'shared-rw' },
          { path: '.cache', mode: 'per-thread' },
        ],
      }),
    );
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest.mounts).toEqual([{ path: '.cache', mode: 'per-thread' }]);
    expect(warnings.some((w) => w.includes('external'))).toBe(true);
  });

  it('ignores a manifest that exceeds the size limit', () => {
    writeManifest(JSON.stringify({ mounts: [{ path: 'x'.repeat(70 * 1024), mode: 'per-thread' }] }));
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest.mounts).toEqual([]);
    expect(warnings[0]).toMatch(/exceeds/);
  });

  it('caps an over-long array and warns', () => {
    writeManifest(
      JSON.stringify({ mounts: Array.from({ length: 250 }, (_, i) => ({ path: `f${i}`, mode: 'per-thread' })) }),
    );
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest.mounts.length).toBe(100);
    expect(warnings.some((w) => w.includes('exceeds'))).toBe(true);
  });

  it('returns empty + a warning on invalid JSON', () => {
    writeManifest('{ not json');
    const { manifest, warnings } = loadLegacyManifestFile(wt);
    expect(manifest).toEqual({ mounts: [] });
    expect(warnings[0]).toMatch(/unreadable/);
  });
});
