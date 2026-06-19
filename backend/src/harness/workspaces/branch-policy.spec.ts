import { describe, expect, it } from 'vitest';
import type { BranchingPolicy } from '@workspace/shared';
import { deriveBranch } from './branch-policy';

// Company-A: features cut from + PR to `dev`; `dev` (base) promotes to `staging`; hotfix off `main`.
const COMPANY_A: BranchingPolicy = {
  base: { from: 'dev', name: '{from}', upstream: 'staging' },
  feature: { from: 'dev', name: 'feature/{slug}', upstream: 'dev' },
  hotfix: { from: 'main', name: 'hotfix/{ticket}', upstream: 'main' },
};

describe('deriveBranch', () => {
  describe('default policy (auto-detection)', () => {
    it('feature off an auto-detected dev base', () => {
      // repo HAS a dev branch → auto resolves to dev
      const d = deriveBranch(
        { kind: 'feature', slug: 'search-bar' },
        null,
        'main',
        'dev',
      );
      expect(d).toEqual({
        branch: 'feature/search-bar',
        baseRef: 'dev',
        upstream: 'dev',
      });
    });

    it('feature off main when no dev/staging exists (auto → projectDefault)', () => {
      const d = deriveBranch(
        { kind: 'feature', slug: 'search bar!' },
        null,
        'main',
        'main', // auto-base fell back to the project default
      );
      expect(d).toEqual({
        branch: 'feature/search-bar',
        baseRef: 'main',
        upstream: 'main',
      });
    });

    it('hotfix always off the project default branch', () => {
      const d = deriveBranch(
        { kind: 'hotfix', ticket: 'ENG-42' },
        null,
        'main',
        'dev',
      );
      expect(d).toEqual({
        branch: 'hotfix/eng-42',
        baseRef: 'main',
        upstream: 'main',
      });
    });

    it('base workstation = the detected base branch itself (no new branch)', () => {
      const d = deriveBranch({ kind: 'base' }, null, 'main', 'dev');
      expect(d).toEqual({ branch: 'dev', baseRef: 'dev', upstream: 'main' });
    });
  });

  describe('company-A policy (explicit)', () => {
    it('feature cut from + PRs to dev', () => {
      const d = deriveBranch(
        { kind: 'feature', slug: 'login' },
        COMPANY_A,
        'main',
        'dev',
      );
      expect(d).toEqual({
        branch: 'feature/login',
        baseRef: 'dev',
        upstream: 'dev',
      });
    });

    it('base dev workstation promotes to staging', () => {
      const d = deriveBranch({ kind: 'base' }, COMPANY_A, 'main', 'dev');
      expect(d).toEqual({ branch: 'dev', baseRef: 'dev', upstream: 'staging' });
    });

    it('hotfix off main even when dev exists', () => {
      const d = deriveBranch(
        { kind: 'hotfix', ticket: 'HOT-9' },
        COMPANY_A,
        'main',
        'dev',
      );
      expect(d).toEqual({
        branch: 'hotfix/hot-9',
        baseRef: 'main',
        upstream: 'main',
      });
    });
  });

  describe('naming + validation', () => {
    it('feature falls back to ticket when slug is absent', () => {
      const d = deriveBranch(
        { kind: 'feature', ticket: 'PROJ-7' },
        null,
        'main',
        'main',
      );
      expect(d.branch).toBe('feature/proj-7');
    });

    it('throws when a feature has neither slug nor ticket', () => {
      expect(() => deriveBranch({ kind: 'feature' }, null, 'main', 'main')).toThrow(
        /needs a slug or ticket/,
      );
    });

    it('throws when a hotfix has neither slug nor ticket', () => {
      expect(() => deriveBranch({ kind: 'hotfix' }, null, 'main', 'main')).toThrow(
        /needs a slug or ticket/,
      );
    });

    it('base never requires a slug', () => {
      expect(() => deriveBranch({ kind: 'base' }, null, 'main', 'main')).not.toThrow();
    });
  });
});
