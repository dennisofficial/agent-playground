import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import type { UserEntity } from '../persistence/entities';

// Deterministic, fast stand-in for argon2 so the spec doesn't pay real hashing cost.
vi.mock('@node-rs/argon2', () => ({
  hash: vi.fn(async (plain: string) => `hashed:${plain}`),
  verify: vi.fn(
    async (hashed: string, plain: string) => hashed === `hashed:${plain}`,
  ),
}));

function makeUser(over: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 'u1',
    email: 'a@b.com',
    password_hash: 'hashed:correct',
    name: 'A',
    role: 'operator',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as UserEntity;
}

describe('AuthService', () => {
  let users: {
    findOne: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let jwt: {
    signAccessToken: ReturnType<typeof vi.fn>;
    signRefreshToken: ReturnType<typeof vi.fn>;
    verifyRefreshToken: ReturnType<typeof vi.fn>;
  };
  let env: { get: ReturnType<typeof vi.fn> };
  let res: {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;

  beforeEach(() => {
    users = {
      findOne: vi.fn(),
      create: vi.fn((x) => x),
      save: vi.fn(async (x) => ({ id: 'u1', ...x })),
    };
    jwt = {
      signAccessToken: vi.fn(async () => 'access-token'),
      signRefreshToken: vi.fn(async () => 'refresh-token'),
      verifyRefreshToken: vi.fn(),
    };
    env = { get: vi.fn(() => undefined) };
    res = { cookie: vi.fn(), clearCookie: vi.fn() };
    service = new AuthService(
      users as unknown as Repository<UserEntity>,
      jwt as never,
      env as never,
    );
  });

  describe('register', () => {
    it('rejects a duplicate email with 409', async () => {
      users.findOne.mockResolvedValue(makeUser());
      await expect(
        service.register(
          'a@b.com',
          'password1',
          'A',
          res as unknown as Response,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(users.save).not.toHaveBeenCalled();
    });

    it('creates an account and immediately issues a session (no approval gate)', async () => {
      users.findOne.mockResolvedValue(null);
      const session = await service.register(
        'new@b.com',
        'password1',
        'New',
        res as unknown as Response,
      );
      expect(users.save).toHaveBeenCalledOnce();
      const saved = users.create.mock.calls[0][0];
      expect(saved).toMatchObject({
        email: 'new@b.com',
        name: 'New',
        password_hash: 'hashed:password1',
        role: 'operator',
      });
      expect(session).toMatchObject({ email: 'new@b.com', name: 'New' });
      expect(res.cookie).toHaveBeenCalledTimes(2);
    });
  });

  describe('login', () => {
    it('rejects unknown email with 401 (no enumeration)', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(
        service.login('x@y.com', 'whatever', res as unknown as Response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong password with 401', async () => {
      users.findOne.mockResolvedValue(
        makeUser({ password_hash: 'hashed:correct' }),
      );
      await expect(
        service.login('a@b.com', 'wrong', res as unknown as Response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('sets both cookies and returns the session for valid creds', async () => {
      users.findOne.mockResolvedValue(makeUser());
      const session = await service.login(
        'a@b.com',
        'correct',
        res as unknown as Response,
      );
      expect(session).toEqual({ id: 'u1', email: 'a@b.com', name: 'A' });
      const names = res.cookie.mock.calls.map((c) => c[0]);
      expect(names).toEqual(['access_token', 'refresh_token']);
      expect(res.cookie.mock.calls[0][2]).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      });
    });
  });

  describe('refresh', () => {
    it('rejects when there is no refresh cookie', async () => {
      const req = { cookies: {} } as unknown as Request;
      await expect(
        service.refresh(req, res as unknown as Response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('reissues cookies for a valid refresh token', async () => {
      const req = { cookies: { refresh_token: 'rt' } } as unknown as Request;
      jwt.verifyRefreshToken.mockResolvedValue({ sub: 'u1' });
      users.findOne.mockResolvedValue(makeUser());
      await service.refresh(req, res as unknown as Response);
      expect(res.cookie).toHaveBeenCalledTimes(2);
    });

    it('rejects when the user no longer exists', async () => {
      const req = { cookies: { refresh_token: 'rt' } } as unknown as Request;
      jwt.verifyRefreshToken.mockResolvedValue({ sub: 'u1' });
      users.findOne.mockResolvedValue(null);
      await expect(
        service.refresh(req, res as unknown as Response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('self-heals a poison cookie: a failed verify clears BOTH host-only and parent-domain scopes', async () => {
      // A sibling preview app under the shared parent set a `.atlas.dltechnologies.co` cookie signed
      // with a different secret; prod can't verify it and must evict it across scopes so login sticks.
      const req = {
        cookies: { refresh_token: 'poison' },
        hostname: 'api.atlas.dltechnologies.co',
      } as unknown as Request;
      jwt.verifyRefreshToken.mockRejectedValue(
        new Error('signature verification failed'),
      );
      await expect(
        service.refresh(req, res as unknown as Response),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      // Cleared both cookie names under host-only (no domain) AND the parent domain.
      const cleared = res.clearCookie.mock.calls.map((c) => ({
        name: c[0],
        domain: c[1]?.domain,
      }));
      expect(cleared).toEqual(
        expect.arrayContaining([
          { name: 'access_token', domain: undefined },
          { name: 'refresh_token', domain: undefined },
          { name: 'access_token', domain: 'atlas.dltechnologies.co' },
          { name: 'refresh_token', domain: 'atlas.dltechnologies.co' },
        ]),
      );
    });

    it('only clears host-only scope when the host has no meaningful parent (dev/localhost)', async () => {
      const req = {
        cookies: { refresh_token: 'x' },
        hostname: 'localhost',
      } as unknown as Request;
      jwt.verifyRefreshToken.mockRejectedValue(new Error('bad'));
      await expect(
        service.refresh(req, res as unknown as Response),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      const domains = res.clearCookie.mock.calls.map((c) => c[1]?.domain);
      expect(domains.every((d) => d === undefined)).toBe(true);
    });
  });

  describe('onApplicationBootstrap (seed admin)', () => {
    it('no-ops when seed env is unset', async () => {
      env.get.mockReturnValue(undefined);
      await service.onApplicationBootstrap();
      expect(users.save).not.toHaveBeenCalled();
    });

    it('provisions an admin when seed env is set and none exists', async () => {
      env.get.mockImplementation((k: string) =>
        k === 'ADMIN_SEED_EMAIL'
          ? 'boss@atlas.dev'
          : k === 'ADMIN_SEED_PASSWORD'
            ? 'secret123'
            : undefined,
      );
      users.findOne.mockResolvedValue(null);
      await service.onApplicationBootstrap();
      const seeded = users.create.mock.calls[0][0];
      expect(seeded).toMatchObject({ email: 'boss@atlas.dev', role: 'admin' });
    });

    it('no-ops when the seed admin already exists', async () => {
      env.get.mockImplementation((k: string) =>
        k === 'ADMIN_SEED_EMAIL'
          ? 'boss@atlas.dev'
          : k === 'ADMIN_SEED_PASSWORD'
            ? 'secret123'
            : undefined,
      );
      users.findOne.mockResolvedValue(makeUser({ email: 'boss@atlas.dev' }));
      await service.onApplicationBootstrap();
      expect(users.save).not.toHaveBeenCalled();
    });
  });
});
