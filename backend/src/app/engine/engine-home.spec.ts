import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { atlasAgentHomeBase, atlasEngineHomeDir } from './engine-home';

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

  it('atlasAgentHomeBase defaults under ~/.agent-playground when no root', () => {
    expect(atlasAgentHomeBase(undefined)).toContain('.agent-playground');
    expect(atlasAgentHomeBase('/custom')).toBe('/custom');
  });
});
