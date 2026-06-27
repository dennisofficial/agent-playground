import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSafeSource, resolveSafeTarget, WorktreePathError } from './worktree-path-guard';

describe('resolveSafeTarget', () => {
  let wt: string;
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'atlas-guard-'));
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  it('resolves a nonexistent leaf inside the worktree', () => {
    const real = realpathSync(wt);
    expect(resolveSafeTarget(wt, '.env.keys')).toBe(join(real, '.env.keys'));
    expect(resolveSafeTarget(wt, 'secrets/sa.json')).toBe(join(real, 'secrets/sa.json'));
  });

  it('rejects traversal', () => {
    expect(() => resolveSafeTarget(wt, '../escape')).toThrow(WorktreePathError);
    expect(() => resolveSafeTarget(wt, 'a/../../escape')).toThrow(WorktreePathError);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafeTarget(wt, '/etc/passwd')).toThrow(WorktreePathError);
  });

  it('rejects a symlinked parent component', () => {
    mkdirSync(join(wt, 'real'));
    symlinkSync(join(wt, 'real'), join(wt, 'link'));
    expect(() => resolveSafeTarget(wt, 'link/file')).toThrow(/symlink/);
  });

  it('rejects an existing symlink leaf', () => {
    writeFileSync(join(wt, 'real.txt'), 'x');
    symlinkSync(join(wt, 'real.txt'), join(wt, 'link.txt'));
    expect(() => resolveSafeTarget(wt, 'link.txt')).toThrow(/symlink/);
  });

  it('rejects a symlink that escapes the worktree even with a benign-looking rel path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'atlas-outside-'));
    symlinkSync(outside, join(wt, 'evil'));
    expect(() => resolveSafeTarget(wt, 'evil/x')).toThrow(/symlink/);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('resolveSafeSource', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atlas-golden-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves an existing source under the root', () => {
    writeFileSync(join(root, '.env.local'), 'x');
    expect(resolveSafeSource(root, '.env.local')).toBe(join(realpathSync(root), '.env.local'));
  });

  it('throws when the source does not exist', () => {
    expect(() => resolveSafeSource(root, 'missing')).toThrow();
  });

  it('rejects traversal out of the golden root', () => {
    expect(() => resolveSafeSource(root, '../x')).toThrow(WorktreePathError);
  });
});
