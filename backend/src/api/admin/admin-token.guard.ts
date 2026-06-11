import { EnvService } from '@core/config/env/env.service';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Gates the admin endpoints (projects/tokens). These mutate which GitHub repo a project's code is
 * pushed to and accept token values — a comment is not containment, so the gate is enforced:
 * `Authorization: Bearer <ADMIN_API_TOKEN>` with a timing-safe compare; when the env var is unset
 * the admin API is DISABLED (503), never open. Single shared bearer is the attended/loopback v0 —
 * real authn/authz comes with the web-admin pass.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly env: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.env.get('ADMIN_API_TOKEN');
    if (!expected) {
      throw new ServiceUnavailableException(
        'Admin API disabled — set ADMIN_API_TOKEN to enable it.',
      );
    }
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const header = String(req.headers['authorization'] ?? '');
    const presented = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid admin token.');
    }
    return true;
  }
}
