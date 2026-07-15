import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveExternalMountTarget,
  resolveSafeTarget,
  WorktreePathError,
} from './worktree-path-guard';

describe('resolveExternalMountTarget', () => {
  it('accepts + normalizes a good absolute container path', () => {
    expect(resolveExternalMountTarget('/root/.config/gcloud')).toBe(
      '/root/.config/gcloud',
    );
    expect(resolveExternalMountTarget('/opt/tools/')).toBe('/opt/tools'); // trailing slash stripped
    expect(resolveExternalMountTarget('/data//cache')).toBe('/data/cache'); // normalized
  });

  it('rejects a relative path (that is a worktree mount, not external)', () => {
    expect(() => resolveExternalMountTarget('.cache')).toThrow(
      WorktreePathError,
    );
  });

  it('rejects traversal', () => {
    expect(() => resolveExternalMountTarget('/opt/../etc/x')).toThrow(
      WorktreePathError,
    );
  });

  it('rejects a reserved system bind / OS root', () => {
    expect(() => resolveExternalMountTarget('/workspace/x')).toThrow(
      WorktreePathError,
    );
    expect(() => resolveExternalMountTarget('/home/atlas')).toThrow(
      WorktreePathError,
    );
    expect(() => resolveExternalMountTarget('/etc/foo')).toThrow(
      WorktreePathError,
    );
    expect(() => resolveExternalMountTarget('/')).toThrow(WorktreePathError);
  });
});

describe('resolveSafeTarget', () => {
  let wt: string;
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'atlas-guard-'));
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  it('resolves a nonexistent leaf inside the worktree', () => {
    const real = realpathSync(wt);
    expect(resolveSafeTarget(wt, '.env.keys')).toBe(join(real, '.env.keys'));
    expect(resolveSafeTarget(wt, 'secrets/sa.json')).toBe(
      join(real, 'secrets/sa.json'),
    );
  });

  it('rejects traversal', () => {
    expect(() => resolveSafeTarget(wt, '../escape')).toThrow(WorktreePathError);
    expect(() => resolveSafeTarget(wt, 'a/../../escape')).toThrow(
      WorktreePathError,
    );
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafeTarget(wt, '/etc/passwd')).toThrow(
      WorktreePathError,
    );
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
