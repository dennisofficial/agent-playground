import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  atlasAgentHomeBase,
  atlasEngineHomeDir,
  engineHomeKeyString,
  safeHomeKey,
  type EngineHomeKey,
} from './engine-home';

const root = join(tmpdir(), `atlas-home-${process.pid}`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const brainKey: EngineHomeKey = {
  orgId: 'acme',
  repoId: 'atlas',
  jobId: 'feat-x',
  type: 'brain',
};

describe('atlasEngineHomeDir (isolated agent home, never ~/.claude)', () => {
  it('creates <root>/<org>/<repo>/<job>/<type>/<engine> and returns the absolute path', () => {
    const dir = atlasEngineHomeDir(root, 'claude', brainKey);
    expect(dir).toBe(join(root, 'acme', 'atlas', 'feat-x', 'brain', 'claude'));
    expect(existsSync(dir)).toBe(true);
    expect(dir).not.toContain('.claude'); // not the personal home
  });

  it('sanitizes every part so a key can never escape the base dir', () => {
    const dir = atlasEngineHomeDir(root, 'codex', {
      orgId: '../../etc',
      repoId: 'passwd',
      jobId: 'job',
      type: 'build',
    });
    expect(dir.startsWith(join(root))).toBe(true);
    expect(dir).not.toContain('..');
  });

  it('keeps two jobs separate', () => {
    const a = atlasEngineHomeDir(root, 'claude', {
      ...brainKey,
      jobId: 'feat-a',
    });
    const b = atlasEngineHomeDir(root, 'claude', {
      ...brainKey,
      jobId: 'feat-b',
    });
    expect(a).not.toBe(b);
  });

  it('keeps two surfaces of the SAME job separate (brain vs build vs autofix)', () => {
    const brain = atlasEngineHomeDir(root, 'claude', {
      ...brainKey,
      type: 'brain',
    });
    const build = atlasEngineHomeDir(root, 'claude', {
      ...brainKey,
      type: 'build',
    });
    expect(brain).not.toBe(build);
  });

  it('keeps two subId sub-sessions of the same (org,repo,job,type) separate', () => {
    const lensA = atlasEngineHomeDir(root, 'claude', {
      ...brainKey,
      type: 'autofix',
      subId: 'review-l1',
    });
    const lensB = atlasEngineHomeDir(root, 'claude', {
      ...brainKey,
      type: 'autofix',
      subId: 'review-l2',
    });
    expect(lensA).not.toBe(lensB);
  });

  it('atlasAgentHomeBase defaults under the repo-relative .atlas-state when no root', () => {
    expect(atlasAgentHomeBase(undefined)).toContain(
      join('.atlas-state', 'agent-home'),
    );
    expect(atlasAgentHomeBase(undefined)).not.toContain('.agent-playground');
    expect(atlasAgentHomeBase('/custom')).toBe('/custom');
  });
});

describe('engineHomeKeyString (cache-key stringification, not a filesystem path)', () => {
  it('is stable for the same key and distinct for different jobs', () => {
    expect(engineHomeKeyString(brainKey)).toBe(
      engineHomeKeyString({ ...brainKey }),
    );
    expect(engineHomeKeyString(brainKey)).not.toBe(
      engineHomeKeyString({ ...brainKey, jobId: 'feat-y' }),
    );
  });

  it('distinguishes a subId sub-session from its parent', () => {
    const parent = engineHomeKeyString({ ...brainKey, type: 'autofix' });
    const child = engineHomeKeyString({
      ...brainKey,
      type: 'autofix',
      subId: 'fix',
    });
    expect(parent).not.toBe(child);
  });
});

describe('safeHomeKey (sanitize + collapse ONE path segment)', () => {
  const uuid = '6899f4d7-2a30-4def-a170-fb182d1841f7';

  it('passes short segments through unchanged', () => {
    expect(safeHomeKey('feat-x')).toBe('feat-x');
    expect(safeHomeKey(uuid)).toBe(uuid); // a real UUID (36 chars) is untouched
  });

  it('collapses a pathological long segment to a short, single-component token', () => {
    const long = `${uuid}-${uuid}-${uuid}`;
    const key = safeHomeKey(long);
    expect(key.length).toBeLessThanOrEqual(40);
    expect(key).not.toContain('/'); // ONE path component — no separator a model could split on
  });

  it('is stable for the same input and distinct for different input', () => {
    const long = `${uuid}-${uuid}-${uuid}`;
    expect(safeHomeKey(long)).toBe(safeHomeKey(long));
    expect(safeHomeKey(long)).not.toBe(safeHomeKey(`${long}-x`));
  });

  it('never lets a segment escape the base dir', () => {
    expect(safeHomeKey('../../etc/passwd')).not.toContain('..');
    expect(safeHomeKey('../../etc/passwd')).not.toContain('/');
  });
});
