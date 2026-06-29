import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { atlasAgentHomeBase, atlasEngineHomeDir, safeHomeKey } from './engine-home';

const root = join(tmpdir(), `atlas-home-${process.pid}`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('atlasEngineHomeDir (isolated agent home, never ~/.claude)', () => {
  it('creates <root>/<sandboxKey>/<engine> and returns the absolute path', () => {
    const dir = atlasEngineHomeDir(root, 'claude', 'acme--atlas/feat-x');
    expect(dir).toBe(join(root, 'acme--atlas_feat-x', 'claude'));
    expect(existsSync(dir)).toBe(true);
    expect(dir).not.toContain('.claude'); // not the personal home
  });

  it('sanitizes a key so it can never escape the base dir', () => {
    const dir = atlasEngineHomeDir(root, 'codex', '../../etc/passwd');
    expect(dir.startsWith(join(root))).toBe(true);
    expect(dir).not.toContain('..');
  });

  it('keeps two sandboxes separate', () => {
    const a = atlasEngineHomeDir(root, 'claude', 'feat-a');
    const b = atlasEngineHomeDir(root, 'claude', 'feat-b');
    expect(a).not.toBe(b);
  });

  it('atlasAgentHomeBase defaults under the repo-relative .atlas-state when no root', () => {
    expect(atlasAgentHomeBase(undefined)).toContain(join('.atlas-state', 'agent-home'));
    expect(atlasAgentHomeBase(undefined)).not.toContain('.agent-playground');
    expect(atlasAgentHomeBase('/custom')).toBe('/custom');
  });
});

describe('safeHomeKey (collapse pathological multi-UUID keys to one short token)', () => {
  const org = '6899f4d7-2a30-4def-a170-fb182d1841f7';
  const repo = '78fd45e1-452c-4195-a9e8-a241ba0ecae5';
  const thread = 'c394f6e2-dc54-4fcb-a3fe-5fda32d17449';
  const brainKey = `brain-${org}-${repo}-${thread}`;

  it('passes short keys through unchanged', () => {
    expect(safeHomeKey('brain-feat-x')).toBe('brain-feat-x');
    expect(safeHomeKey('plan-review-abc')).toBe('plan-review-abc');
  });

  it('collapses a brain-<org>-<repo>-<thread> key to a short, single-component token', () => {
    const key = safeHomeKey(brainKey);
    expect(key.length).toBeLessThanOrEqual(40);
    // ONE path component — no internal separators a model could split the spill path on.
    expect(key).not.toContain('/');
    expect(key.startsWith('brain_')).toBe(true);
  });

  it('is stable for the same key and distinct for different threads', () => {
    expect(safeHomeKey(brainKey)).toBe(safeHomeKey(brainKey));
    const other = `brain-${org}-${repo}-00000000-0000-0000-0000-000000000000`;
    expect(safeHomeKey(brainKey)).not.toBe(safeHomeKey(other));
  });

  it('produces a home dir that is a single component under the base', () => {
    const dir = atlasEngineHomeDir(root, 'claude', brainKey);
    const rel = dir.slice(root.length + 1); // strip "<root>/"
    expect(rel.split('/')).toEqual([safeHomeKey(brainKey), 'claude']);
  });
});
