import { EnvService } from '@core/config/env/env.service';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BaseAuthGuard, JwtService } from '@workspace/auth/server';
import { timingSafeEqual } from 'node:crypto';
import { AdminUserStore } from './admin-user.store';

/**
 * Authentication guard for admin API controllers.
 *
 * Primary path  — validates the access_token httpOnly cookie (set by /auth/login).
 * M2M fallback  — if no cookie is present, checks for `Authorization: Bearer <ADMIN_API_TOKEN>`,
 *                 a timing-safe compare against the env var.  This lets existing machine-to-machine
 *                 callers keep working while the web portal migrates to cookie auth.
 *
 * Register as APP_GUARD or per-controller with @UseGuards(AdminAuthGuard).
 */
@Injectable()
export class AdminAuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    private readonly store: AdminUserStore,
    private readonly env: EnvService,
  ) {
    super(reflector, jwtService);
  }

  async findUser(sub: string) {
    return this.store.findById(sub);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    // Try M2M bearer first — if it matches ADMIN_API_TOKEN we grant access
    // without going through JWT, so existing tooling keeps working.
    const m2mToken = this.env.get('ADMIN_API_TOKEN');
    if (m2mToken) {
      const req = context
        .switchToHttp()
        .getRequest<{ headers: Record<string, unknown> }>();
      const header = String(req.headers['authorization'] ?? '');
      if (header.startsWith('Bearer ')) {
        const presented = header.slice('Bearer '.length);
        const a = Buffer.from(presented);
        const b = Buffer.from(m2mToken);
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return true;
        }
      }
    }

    // Fall through to cookie/JWT path from BaseAuthGuard
    return super.canActivate(context);
  }
}
