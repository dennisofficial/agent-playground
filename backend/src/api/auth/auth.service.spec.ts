import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@workspace/auth/server';
import type { Response } from 'express';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { AdminUserRepo } from './admin-user.repo';
import { AuthService } from './auth.service';
import * as pwUtil from './password.util';

// ─── stubs ────────────────────────────────────────────────────────────────────

const mockUser = {
  id: 'uuid-1',
  email: 'admin@example.com',
  password_hash: '$argon2id$fakeHash',
  name: 'Admin',
  role: 'admin',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

function makeRepo(user: typeof mockUser | null = mockUser): AdminUserRepo {
  return {
    findOne: vi.fn().mockResolvedValue(user),
  } as unknown as AdminUserRepo;
}

function makeJwt(): JwtService {
  return {
    signAccessToken: vi.fn().mockResolvedValue('access.token'),
    signRefreshToken: vi.fn().mockResolvedValue('refresh.token'),
    verifyAccessToken: vi.fn().mockResolvedValue({ sub: mockUser.id }),
    verifyRefreshToken: vi.fn().mockResolvedValue({ sub: mockUser.id }),
  };
}

function makeEnv(nodeEnv = 'test'): EnvService {
  return {
    get: vi.fn((k: string) => {
      if (k === 'NODE_ENV') return nodeEnv;
      if (k === 'COOKIE_DOMAIN') return undefined;
      if (k === 'BACKEND_HOST') return 'http://localhost:4000';
      return undefined;
    }),
  } as unknown as EnvService;
}

function makeRes(): Response {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('login()', () => {
    it('sets cookies and returns the user view on correct credentials', async () => {
      vi.spyOn(pwUtil, 'verifyPassword').mockResolvedValue(true);
      const res = makeRes();
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());

      const result = await svc.login('admin@example.com', 'secret', res);

      expect(result.user.id).toBe(mockUser.id);
      expect(result.user.email).toBe(mockUser.email);
      expect((result.user as any).password_hash).toBeUndefined();
      expect(res.cookie).toHaveBeenCalledTimes(2);
    });

    it('throws UnauthorizedException when user not found', async () => {
      const svc = new AuthService(makeRepo(null), makeJwt(), makeEnv());
      await expect(svc.login('nope@x.com', 'pw', makeRes())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException on wrong password', async () => {
      vi.spyOn(pwUtil, 'verifyPassword').mockResolvedValue(false);
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());
      await expect(
        svc.login('admin@example.com', 'wrong', makeRes()),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('getSession()', () => {
    it('returns the user view from a valid access cookie', async () => {
      const req = { cookies: { access_token: 'valid.jwt' } };
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());
      const result = await svc.getSession(req as any);
      expect(result.id).toBe(mockUser.id);
      expect((result as any).password_hash).toBeUndefined();
    });

    it('throws when no cookie is present', async () => {
      const req = { cookies: {} };
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());
      await expect(svc.getSession(req as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws when the JWT is invalid', async () => {
      const badJwt = {
        ...makeJwt(),
        verifyAccessToken: vi.fn().mockRejectedValue(new Error('expired')),
      } as unknown as JwtService;
      const req = { cookies: { access_token: 'bad.jwt' } };
      const svc = new AuthService(makeRepo(), badJwt, makeEnv());
      await expect(svc.getSession(req as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refresh()', () => {
    it('rotates tokens and returns the user view', async () => {
      const req = { cookies: { refresh_token: 'valid.refresh' } };
      const res = makeRes();
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());
      const result = await svc.refresh(req as any, res);
      expect(result.user.id).toBe(mockUser.id);
      expect(res.cookie).toHaveBeenCalledTimes(2);
    });

    it('throws when no refresh cookie is present', async () => {
      const req = { cookies: {} };
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());
      await expect(svc.refresh(req as any, makeRes())).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout()', () => {
    it('clears both auth cookies', () => {
      const res = makeRes();
      const svc = new AuthService(makeRepo(), makeJwt(), makeEnv());
      svc.logout(res);
      expect(res.clearCookie).toHaveBeenCalledTimes(2);
    });
  });
});
