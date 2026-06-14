import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@workspace/auth/server';
import { describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { AdminUserRepo } from './admin-user.repo';
import { AdminAuthGuard } from './admin-auth.guard';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeReflector(isPublic = false): Reflector {
  return {
    getAllAndOverride: vi.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
}

function makeJwt(sub?: string): JwtService {
  return {
    verifyAccessToken: vi.fn().mockResolvedValue({ sub }),
  };
}

function makeRepo(user: unknown = { id: 'u1', role: 'admin' }): AdminUserRepo {
  return {
    findOne: vi.fn().mockResolvedValue(user),
  } as unknown as AdminUserRepo;
}

function makeEnv(token?: string): EnvService {
  return {
    get: vi.fn((k: string) => {
      if (k === 'ADMIN_API_TOKEN') return token;
      if (k === 'NODE_ENV') return 'development';
      return undefined;
    }),
  } as unknown as EnvService;
}

function makeCtx(
  authorization?: string,
  cookies: Record<string, string> = {},
): ExecutionContext {
  return {
    getHandler: vi.fn().mockReturnValue({}),
    getClass: vi.fn().mockReturnValue({}),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authorization ? { authorization } : {},
        cookies,
      }),
    }),
  } as unknown as ExecutionContext;
}

function guard(opts: {
  isPublic?: boolean;
  sub?: string;
  user?: unknown;
  m2mToken?: string;
}) {
  return new AdminAuthGuard(
    makeReflector(opts.isPublic ?? false),
    makeJwt(opts.sub),
    makeRepo(opts.user ?? { id: opts.sub ?? 'u1', role: 'admin' }),
    makeEnv(opts.m2mToken),
  );
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('AdminAuthGuard', () => {
  it('passes when the route is @Public()', async () => {
    const g = guard({ isPublic: true });
    const result = await g.canActivate(makeCtx());
    expect(result).toBe(true);
  });

  it('grants access to a valid M2M bearer (ADMIN_API_TOKEN)', async () => {
    const g = guard({ m2mToken: 'my-static-token' });
    const result = await g.canActivate(makeCtx('Bearer my-static-token'));
    expect(result).toBe(true);
  });

  it('rejects a wrong M2M bearer and falls through to JWT (no cookie → 401)', async () => {
    const g = guard({ m2mToken: 'correct-token' });
    await expect(g.canActivate(makeCtx('Bearer wrong-token'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('grants access to a valid access_token cookie', async () => {
    const g = guard({ sub: 'user-uuid' });
    const result = await g.canActivate(
      makeCtx(undefined, { access_token: 'valid.jwt.token' }),
    );
    expect(result).toBe(true);
  });

  it('rejects when the JWT has no sub', async () => {
    const g = guard({ sub: undefined });
    await expect(
      g.canActivate(makeCtx(undefined, { access_token: 'bad.jwt.token' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when findUser returns null', async () => {
    const g = guard({ sub: 'ghost-user', user: null });
    await expect(
      g.canActivate(makeCtx(undefined, { access_token: 'valid.jwt.token' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws ForbiddenException when @Roles check fails', async () => {
    const reflector: Reflector = {
      getAllAndOverride: vi.fn((key: string) => {
        if (key === 'IS_PUBLIC_KEY') return false;
        if (key === 'IS_AUTH_ONLY_KEY') return false;
        if (key === 'ROLES_KEY') return ['superadmin'];
        return undefined;
      }),
    } as unknown as Reflector;

    const g = new AdminAuthGuard(
      reflector,
      makeJwt('u1'),
      makeRepo({ id: 'u1', role: 'admin' }),
      makeEnv(),
    );

    await expect(
      g.canActivate(makeCtx(undefined, { access_token: 'jwt' })),
    ).rejects.toThrow(ForbiddenException);
  });
});
