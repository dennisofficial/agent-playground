import { EnvService } from '@core/config/env/env.service';
import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@workspace/auth/server';
import { hash, verify } from '@node-rs/argon2';
import type { CookieOptions, Request, Response } from 'express';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { UserEntity } from '../persistence/entities';
import type { AuthSession } from './dto/auth.dto';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/auth/refresh';
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // mirrors JwtModule's default 15m access TTL
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // mirrors the default 7d refresh TTL

/**
 * Email/password auth for the Atlas web console. Argon2id hashing, JWT access+refresh in httpOnly
 * cookies (the `@workspace/auth` web client is cookie-mode). Registration is OPEN and immediately
 * usable — a fresh account signs in and then creates or joins an organization. No approval gate. The
 * seeded admin (`ADMIN_SEED_*`) is provisioned on boot so there's always a way in.
 */
@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity, DB_CONNECTION)
    private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
  ) {}

  /** Seed the admin from env on boot (idempotent), so there's always a way in. */
  async onApplicationBootstrap(): Promise<void> {
    const email = this.env.get('ADMIN_SEED_EMAIL');
    const password = this.env.get('ADMIN_SEED_PASSWORD');
    if (!email || !password) return;

    const existing = await this.users.findOne({ where: { email } });
    if (existing) return;

    await this.users.save(
      this.users.create({
        email,
        name: 'Admin',
        password_hash: await hash(password),
        role: 'admin',
      }),
    );
    this.logger.log(`Seed admin ${email} provisioned.`);
  }

  /** Create an account and immediately issue a session (open registration, no approval gate). */
  async register(
    email: string,
    password: string,
    name: string | undefined,
    res: Response,
  ): Promise<AuthSession> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    const user = await this.users.save(
      this.users.create({
        email,
        name: name ?? null,
        password_hash: await hash(password),
        role: 'operator',
      }),
    );
    await this.issueTokens(user, res);
    return this.toSession(user);
  }

  /** Verify credentials, then set cookies. Returns the session object. */
  async login(email: string, password: string, res: Response): Promise<AuthSession> {
    const user = await this.users.findOne({ where: { email } });
    // Same error for missing user vs bad password (no account enumeration).
    if (!user || !(await verify(user.password_hash, password))) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    await this.issueTokens(user, res);
    return this.toSession(user);
  }

  /**
   * Re-issue tokens from a valid refresh cookie (the access token is expired by design).
   *
   * Each 401 path logs its exact reason: a refresh 401 was observed TRANSIENTLY around a dev
   * watch-respawn (07-01) with cookies a plain reload proved valid — which no path here should be able
   * to produce — so the next occurrence must be attributable (missing cookie vs verify failure and its
   * jose reason vs user lookup miss).
   */
  async refresh(req: Request, res: Response): Promise<void> {
    const token = this.readCookie(req, REFRESH_COOKIE);
    if (!token) {
      this.logger.warn('refresh 401: no refresh_token cookie on the request');
      throw new UnauthorizedException('No refresh token');
    }

    let sub: string | undefined;
    try {
      ({ sub } = await this.jwt.verifyRefreshToken(token));
    } catch (err) {
      this.logger.warn(
        `refresh 401: refresh token failed verification — ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const user = sub ? await this.users.findOne({ where: { id: sub } }) : null;
    if (!user) {
      this.logger.warn(`refresh 401: no user found for sub=${sub ?? '(none)'}`);
      throw new UnauthorizedException('Session no longer valid');
    }

    await this.issueTokens(user, res);
  }

  /** Clear both auth cookies (matching their set-paths). */
  clearTokens(res: Response): void {
    const base = this.cookieBase();
    res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
  }

  private toSession(user: UserEntity): AuthSession {
    return { id: user.id, email: user.email, name: user.name };
  }

  private async issueTokens(user: UserEntity, res: Response): Promise<void> {
    const [access, refresh] = await Promise.all([
      this.jwt.signAccessToken(user.id, { userId: user.id }),
      this.jwt.signRefreshToken(user.id),
    ]);
    const base = this.cookieBase();
    res.cookie(ACCESS_COOKIE, access, { ...base, path: '/', maxAge: ACCESS_MAX_AGE_MS });
    res.cookie(REFRESH_COOKIE, refresh, {
      ...base,
      path: REFRESH_PATH,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }

  private cookieBase(): Pick<CookieOptions, 'httpOnly' | 'sameSite' | 'secure' | 'domain'> {
    const domain = this.env.get('COOKIE_DOMAIN');
    return {
      httpOnly: true,
      sameSite: 'lax',
      // Must be false over http (local dev) or the browser drops the cookie.
      secure: this.env.get('NODE_ENV') === 'production',
      ...(domain ? { domain } : {}),
    };
  }

  private readCookie(req: Request, name: string): string | null {
    return (req as Request & { cookies?: Record<string, string> }).cookies?.[name] ?? null;
  }
}
