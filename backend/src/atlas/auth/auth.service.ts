import { EnvService } from '@core/config/env/env.service';
import {
  ConflictException,
  ForbiddenException,
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
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasUser } from '../persistence/entities';
import type { AtlasSession } from './dto/auth.dto';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/auth/refresh';
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // mirrors JwtModule's default 15m access TTL
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // mirrors the default 7d refresh TTL

/** The pending-approval message surfaced to the signup banner (unwrapped client-side from the 403). */
const PENDING_MESSAGE =
  "Account created — pending approval. You'll be able to sign in once it's been invited/approved.";

/**
 * Email/password auth for the Atlas web console. Argon2id hashing, JWT access+refresh in httpOnly
 * cookies (the `@workspace/auth` web client is cookie-mode). Registration is OPEN but every new account
 * is created UNAPPROVED (`is_approved: false`) and cannot log in until the flag is flipped — the
 * "invite". The seeded admin (`ADMIN_SEED_*`) is provisioned approved on boot so Dennis can log in.
 */
@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(AtlasUser, ATLAS_CONNECTION)
    private readonly users: Repository<AtlasUser>,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
  ) {}

  /** Seed the approved admin from env on boot (idempotent), so there's always a way in. */
  async onApplicationBootstrap(): Promise<void> {
    const email = this.env.get('ADMIN_SEED_EMAIL');
    const password = this.env.get('ADMIN_SEED_PASSWORD');
    if (!email || !password) return;

    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      if (!existing.is_approved) {
        existing.is_approved = true;
        await this.users.save(existing);
        this.logger.log(`Seed admin ${email} re-approved.`);
      }
      return;
    }

    await this.users.save(
      this.users.create({
        email,
        password_hash: await hash(password),
        role: 'admin',
        is_approved: true,
      }),
    );
    this.logger.log(`Seed admin ${email} provisioned (approved).`);
  }

  /**
   * Create an account in the UNAPPROVED state and ALWAYS reject with the pending message — open
   * registration, blocked by flag. The row IS persisted; only the session is withheld until approval.
   */
  async register(email: string, password: string): Promise<never> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    await this.users.save(
      this.users.create({
        email,
        password_hash: await hash(password),
        role: 'operator',
        is_approved: false,
      }),
    );
    // 403 → unwrapped to the signup banner by the RealAuth adapter (web/src/lib/auth.ts).
    throw new ForbiddenException(PENDING_MESSAGE);
  }

  /** Verify credentials + approval, then set cookies. Returns the session object. */
  async login(email: string, password: string, res: Response): Promise<AtlasSession> {
    const user = await this.users.findOne({ where: { email } });
    // Same error for missing user vs bad password (no account enumeration).
    if (!user || !(await verify(user.password_hash, password))) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    if (!user.is_approved) {
      throw new ForbiddenException('Account pending approval.');
    }
    await this.issueTokens(user, res);
    return { id: user.id, email: user.email };
  }

  /** Re-issue tokens from a valid refresh cookie (the access token is expired by design). */
  async refresh(req: Request, res: Response): Promise<void> {
    const token = this.readCookie(req, REFRESH_COOKIE);
    if (!token) throw new UnauthorizedException('No refresh token');

    let sub: string | undefined;
    try {
      ({ sub } = await this.jwt.verifyRefreshToken(token));
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const user = sub ? await this.users.findOne({ where: { id: sub } }) : null;
    if (!user || !user.is_approved) throw new UnauthorizedException('Session no longer valid');

    await this.issueTokens(user, res);
  }

  /** Clear both auth cookies (matching their set-paths). */
  clearTokens(res: Response): void {
    const base = this.cookieBase();
    res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
  }

  private async issueTokens(user: AtlasUser, res: Response): Promise<void> {
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
