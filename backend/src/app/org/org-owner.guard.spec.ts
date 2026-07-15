import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { OrgOwnerGuard } from './org-owner.guard';

/** A minimal ExecutionContext whose HTTP request carries the given `org` context. */
function ctxWithOrg(
  org: { id: string; role: string } | undefined,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ org }) }),
  } as unknown as ExecutionContext;
}

describe('OrgOwnerGuard', () => {
  const guard = new OrgOwnerGuard();

  it('allows the owner', () => {
    expect(guard.canActivate(ctxWithOrg({ id: 'O1', role: 'owner' }))).toBe(
      true,
    );
  });

  it('denies plain members', () => {
    expect(() =>
      guard.canActivate(ctxWithOrg({ id: 'O1', role: 'member' })),
    ).toThrow(ForbiddenException);
  });

  it('denies an unknown role', () => {
    expect(() =>
      guard.canActivate(ctxWithOrg({ id: 'O1', role: 'operator' })),
    ).toThrow(ForbiddenException);
  });

  it('fails closed when membership never ran (no org on request)', () => {
    expect(() => guard.canActivate(ctxWithOrg(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
