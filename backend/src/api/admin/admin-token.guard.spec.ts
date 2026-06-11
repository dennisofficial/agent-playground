import type { EnvService } from '@core/config/env/env.service';
import type { ExecutionContext } from '@nestjs/common';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';

const ctx = (authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization ? { authorization } : {} }),
    }),
  }) as unknown as ExecutionContext;

const guard = (token?: string) =>
  new AdminTokenGuard({
    get: (k: string) => (k === 'ADMIN_API_TOKEN' ? token : undefined),
  } as unknown as EnvService);

describe('AdminTokenGuard', () => {
  it('is DISABLED (503) when ADMIN_API_TOKEN is unset — never open by default', () => {
    expect(() => guard(undefined).canActivate(ctx('Bearer anything'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects missing, malformed, and wrong bearers with 401', () => {
    const g = guard('correct-token');
    expect(() => g.canActivate(ctx())).toThrow(UnauthorizedException);
    expect(() => g.canActivate(ctx('correct-token'))).toThrow(
      UnauthorizedException,
    ); // no Bearer prefix
    expect(() => g.canActivate(ctx('Bearer wrong'))).toThrow(
      UnauthorizedException,
    );
    expect(() => g.canActivate(ctx('Bearer correct-token-x'))).toThrow(
      UnauthorizedException,
    );
  });

  it('passes on the exact bearer', () => {
    expect(
      guard('correct-token').canActivate(ctx('Bearer correct-token')),
    ).toBe(true);
  });
});
