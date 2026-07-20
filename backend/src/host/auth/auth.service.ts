import { EnvService } from '@core/config/env/env.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { JwtService } from '@workspace/auth/server';
import { EUserRole, EUserStatus, type AuthSession } from '@workspace/shared';
import type { CookieOptions, Request, Response } from 'express';
import { User, UserRepo } from '../../_lib/database/entities/user.entity';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/auth/refresh';
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // mirrors JwtModule's default 15m access TTL
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // mirrors the default 7d refresh TTL

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UserRepo,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
  ) {}

  /** Provision the dev admin from ADMIN_SEED_* on boot (active, so it can sign in immediately). */
  async onApplicationBootstrap(): Promise<void> {
    const email = this.env.get('ADMIN_SEED_EMAIL');
    const password = this.env.get('ADMIN_SEED_PASSWORD');
    if (!email || !password) return;
    if (await this.users.findOne({ where: { email } })) return;

    await this.users.save(
      this.users.create({
        email,
        name: 'Admin',
        passwordHash: await hash(password),
        role: EUserRole.ADMIN,
        status: EUserStatus.ACTIVE,
      }),
    );
    this.logger.log(`Seed admin ${email} provisioned.`);
  }

  /**
   * Register a new account. New accounts land as `pending` and cannot sign in until an
   * operator approves them — so this never issues tokens; it always ends in a 403.
   */
  async register(email: string, password: string, name: string | undefined): Promise<never> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    await this.users.save(
      this.users.create({
        email,
        name: name ?? null,
        passwordHash: await hash(password),
        role: EUserRole.OPERATOR,
        status: EUserStatus.PENDING,
      }),
    );
    throw new ForbiddenException('Your account is pending approval.');
  }

  async login(email: string, password: string, res: Response): Promise<AuthSession> {
    const user = await this.users.findOne({ where: { email } });
    if (!user || !(await verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    this.assertActive(user);
    await this.issueTokens(user, res);
    return this.toSession(user);
  }

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
      this.clearTokensAllScopes(req, res);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = sub ? await this.users.findOne({ where: { id: sub } }) : null;
    if (!user) {
      this.logger.warn(`refresh 401: no user found for sub=${sub ?? '(none)'}`);
      this.clearTokensAllScopes(req, res);
      throw new UnauthorizedException('Session no longer valid');
    }
    this.assertActive(user);
    await this.issueTokens(user, res);
  }

  clearTokens(res: Response): void {
    const base = this.cookieBase();
    res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
  }

  private assertActive(user: User): void {
    if (user.status === EUserStatus.PENDING) {
      throw new ForbiddenException('Your account is pending approval.');
    }
    if (user.status === EUserStatus.SUSPENDED) {
      throw new ForbiddenException('Your account has been suspended.');
    }
  }

  /**
   * Clear session cookies across both the host-only and parent-domain scopes. Guards against
   * a stale parent-domain cookie (e.g. from a preview deploy) shadowing the host-only one.
   */
  private clearTokensAllScopes(req: Request, res: Response): void {
    const base = this.cookieBase();
    const domains: Array<string | undefined> = [base.domain];
    const parent = this.parentDomain(req.hostname);
    if (parent && parent !== base.domain) domains.push(parent);
    for (const domain of domains) {
      const opts = { ...base, ...(domain ? { domain } : { domain: undefined }) };
      res.clearCookie(ACCESS_COOKIE, { ...opts, path: '/' });
      res.clearCookie(REFRESH_COOKIE, { ...opts, path: REFRESH_PATH });
    }
  }

  private parentDomain(host: string | undefined): string | null {
    if (!host) return null;
    const labels = host.split('.');
    if (labels.length < 3) return null;
    return labels.slice(1).join('.');
  }

  private toSession(user: User): AuthSession {
    return { id: user.id, email: user.email, name: user.name };
  }

  private async issueTokens(user: User, res: Response): Promise<void> {
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
      secure: this.env.get('NODE_ENV') === 'production',
      ...(domain ? { domain } : {}),
    };
  }

  private readCookie(req: Request, name: string): string | null {
    return (req as Request & { cookies?: Record<string, string> }).cookies?.[name] ?? null;
  }
}
