import { describe, expect, it } from 'vitest';
import {
  isExternalMountPath,
  isReservedContainerPath,
  isReservedMountPath,
  MAX_MOUNT_PATH_LEN,
  normalizeMountPath,
  normalizeMounts,
} from '../container-paths';

describe('isExternalMountPath', () => {
  it('is true for an absolute container path, false for a worktree-relative one', () => {
    expect(isExternalMountPath('/root/.config/gcloud')).toBe(true);
    expect(isExternalMountPath('/opt/tools')).toBe(true);
    expect(isExternalMountPath('.cache')).toBe(false);
    expect(isExternalMountPath('a/b/c')).toBe(false);
  });
});

describe('isReservedContainerPath', () => {
  it('allows ordinary out-of-worktree dirs an external mount may target', () => {
    expect(isReservedContainerPath('/root/.config/gcloud')).toBe(false);
    expect(isReservedContainerPath('/home/user/.aws')).toBe(false);
    expect(isReservedContainerPath('/data/cache')).toBe(false);
    expect(isReservedContainerPath('/opt/tools')).toBe(false);
  });

  it('rejects the root, system binds, and OS-critical dirs (IS / under / ancestor)', () => {
    expect(isReservedContainerPath('/')).toBe(true);
    expect(isReservedContainerPath('/workspace')).toBe(true);
    expect(isReservedContainerPath('/workspace/x')).toBe(true); // under
    expect(isReservedContainerPath('/.atlas')).toBe(true);
    expect(isReservedContainerPath('/home/atlas')).toBe(true);
    expect(isReservedContainerPath('/home')).toBe(true); // ancestor of the reserved /home/atlas
    expect(isReservedContainerPath('/etc')).toBe(true);
    expect(isReservedContainerPath('/usr/bin')).toBe(true); // under /usr
    expect(isReservedContainerPath('/context/generated')).toBe(true);
  });

  it('rejects the nested system caches under /.atlas (pnpm store, fnm store, git-common)', () => {
    expect(isReservedContainerPath('/.atlas/pnpm-store')).toBe(true);
    expect(isReservedContainerPath('/.atlas/fnm')).toBe(true);
    expect(isReservedContainerPath('/.atlas/git-common')).toBe(true);
  });
});

describe('normalizeMountPath', () => {
  it('strips a leading ./, trailing slashes, and collapses repeated slashes', () => {
    expect(normalizeMountPath('./.pnpm-store')).toBe('.pnpm-store');
    expect(normalizeMountPath('.pnpm-store/')).toBe('.pnpm-store');
    expect(normalizeMountPath('a//b/')).toBe('a/b');
    expect(normalizeMountPath('.next/cache')).toBe('.next/cache');
  });
});

describe('isReservedMountPath', () => {
  it('matches the system-managed pnpm store in its normalized variants', () => {
    expect(isReservedMountPath('.pnpm-store')).toBe(true);
    expect(isReservedMountPath('./.pnpm-store')).toBe(true);
    expect(isReservedMountPath('.pnpm-store/')).toBe(true);
  });

  it('does not match ordinary cache paths', () => {
    expect(isReservedMountPath('.next/cache')).toBe(false);
    expect(isReservedMountPath('.venv')).toBe(false);
    expect(isReservedMountPath('node_modules/.cache')).toBe(false);
  });
});

describe('normalizeMounts', () => {
  it('ignores non-array input', () => {
    expect(normalizeMounts(undefined)).toEqual({ mounts: [], warnings: [] });
    expect(normalizeMounts(null)).toEqual({ mounts: [], warnings: [] });
    expect(normalizeMounts('not-an-array')).toEqual({
      mounts: [],
      warnings: [],
    });
  });

  it('drops a path with a ".." segment', () => {
    expect(normalizeMounts([{ path: '../evil' }])).toEqual({
      mounts: [],
      warnings: [],
    });
    expect(normalizeMounts([{ path: 'a/../b' }])).toEqual({
      mounts: [],
      warnings: [],
    });
  });

  it('drops a path over MAX_MOUNT_PATH_LEN', () => {
    const tooLong = 'a'.repeat(MAX_MOUNT_PATH_LEN + 1);
    expect(normalizeMounts([{ path: tooLong }])).toEqual({
      mounts: [],
      warnings: [],
    });
  });

  it('drops a reserved worktree-relative path with a warning', () => {
    const { mounts, warnings } = normalizeMounts([{ path: '.pnpm-store' }]);
    expect(mounts).toEqual([]);
    expect(warnings).toEqual([
      'mount ".pnpm-store" is auto-managed by the system (do not add it) — dropped',
    ]);
  });

  it('drops a reserved absolute/container path with a warning', () => {
    const workspace = normalizeMounts([{ path: '/workspace' }]);
    expect(workspace.mounts).toEqual([]);
    expect(workspace.warnings).toEqual([
      'mount "/workspace" targets a reserved/system container path (do not mount it) — dropped',
    ]);

    const atlasHome = normalizeMounts([{ path: '/.atlas' }]);
    expect(atlasHome.mounts).toEqual([]);
    expect(atlasHome.warnings).toEqual([
      'mount "/.atlas" targets a reserved/system container path (do not mount it) — dropped',
    ]);
  });

  it('defaults mode to per-thread when omitted', () => {
    expect(normalizeMounts([{ path: 'some/cache' }])).toEqual({
      mounts: [{ path: 'some/cache', mode: 'per-thread' }],
      warnings: [],
    });
  });

  it('accepts shared-ro and shared-rw explicitly', () => {
    expect(normalizeMounts([{ path: 'a', mode: 'shared-ro' }])).toEqual({
      mounts: [{ path: 'a', mode: 'shared-ro' }],
      warnings: [],
    });
    expect(normalizeMounts([{ path: 'b', mode: 'shared-rw' }])).toEqual({
      mounts: [{ path: 'b', mode: 'shared-rw' }],
      warnings: [],
    });
  });
});
