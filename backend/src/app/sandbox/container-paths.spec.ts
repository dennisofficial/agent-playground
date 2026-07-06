import { describe, expect, it } from 'vitest';
import {
  isExternalMountPath,
  isReservedContainerPath,
  isReservedMountPath,
  normalizeMountPath,
} from './container-paths';

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
