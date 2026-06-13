import { EnvService } from '@core/config/env/env.service';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@workspace/auth/server';
import type { IAdminUserResponse, LoginResponse } from '@workspace/shared';
import type { AdminUser } from '@workspace/shared/schemas';
import type { Request, Response } from 'express';
import { AdminUserRepo } from './admin-user.repo';
import { verifyPassword } from './password.util';

/** Seconds in a day, used for cookie maxAge calculations. */
const DAY = 24 * 60 * 60;

function toView(user: AdminUser): IAdminUserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.created_at,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AdminUserRepo,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
  ) {}

  // ─── cookie helpers ────────────────────────────────────────────────────────

  private get cookieDomain(): string | undefined {
    return this.env.get('COOKIE_DOMAIN') ?? undefined;
  }

  private setAccessCookie(res: Response, token: string): void {
    res.cookie('access_token', token, {
      httpOnly: true,
      secure: this.env.get('NODE_ENV') !== 'development',
      sameSite: 'lax',
      domain: this.cookieDomain,
      path: '/',
      maxAge: 15 * 60 * 1000, // 15 min in ms
    });
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie('refresh_token', token, {
      httpOnly: true,
      secure: this.env.get('NODE_ENV') !== 'development',
      sameSite: 'lax',
      domain: this.cookieDomain,
      path: '/auth/refresh',
      maxAge: 7 * DAY * 1000, // 7 days in ms
    });
  }

  private clearAuthCookies(res: Response): void {
    const base = {
      httpOnly: true,
      secure: this.env.get('NODE_ENV') !== 'development',
      sameSite: 'lax' as const,
      domain: this.cookieDomain,
    };
    res.clearCookie('access_token', { ...base, path: '/' });
    res.clearCookie('refresh_token', { ...base, path: '/auth/refresh' });
  }

  // ─── public API ────────────────────────────────────────────────────────────

  async login(
    email: string,
    password: string,
    res: Response,
  ): Promise<LoginResponse> {
    const user = await this.repo.findOne({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const [access, refresh] = await Promise.all([
      this.jwt.signAccessToken(user.id),
      this.jwt.signRefreshToken(user.id),
    ]);

    this.setAccessCookie(res, access);
    this.setRefreshCookie(res, refresh);

    return { user: toView(user) };
  }

  /**
   * Verify the access token from the request cookie and return the bare
   * IAdminUserResponse (no password_hash — this is the session probe endpoint).
   */
  async getSession(req: Request): Promise<IAdminUserResponse> {
    const token: string | undefined = (req as any).cookies?.['access_token'];
    if (!token) throw new UnauthorizedException('Not authenticated');

    let sub: string;
    try {
      const payload = await this.jwt.verifyAccessToken(token);
      if (!payload.sub) throw new Error('missing sub');
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.repo.findOne({ where: { id: sub } });
    if (!user) throw new UnauthorizedException('User not found');
    return toView(user);
  }

  /** Rotate refresh → new access + new refresh, set both cookies. */
  async refresh(req: Request, res: Response): Promise<LoginResponse> {
    const token: string | undefined =
      (req as any).cookies?.['refresh_token'];
    if (!token) throw new UnauthorizedException('No refresh token');

    let sub: string;
    try {
      const payload = await this.jwt.verifyRefreshToken(token);
      if (!payload.sub) throw new Error('missing sub');
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.repo.findOne({ where: { id: sub } });
    if (!user) throw new UnauthorizedException('User not found');

    const [access, refresh] = await Promise.all([
      this.jwt.signAccessToken(user.id),
      this.jwt.signRefreshToken(user.id),
    ]);

    this.setAccessCookie(res, access);
    this.setRefreshCookie(res, refresh);

    return { user: toView(user) };
  }

  logout(res: Response): void {
    this.clearAuthCookies(res);
  }
}
