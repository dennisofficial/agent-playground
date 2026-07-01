import { describe, expect, it } from 'vitest';
import { isReservedMountPath, normalizeMountPath } from './container-paths';

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
    expect(isReservedMountPath('.cocoindex')).toBe(false);
    expect(isReservedMountPath('node_modules/.cache')).toBe(false);
  });
});
