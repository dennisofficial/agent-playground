import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import { AppVersionService } from './app-version.service';

function envMock(GIT_SHA: string | undefined): EnvService {
  return { get: () => GIT_SHA } as unknown as EnvService;
}

describe('AppVersionService', () => {
  it('defaults to "dev" when GIT_SHA is unset', () => {
    const svc = new AppVersionService(envMock(undefined));
    expect(svc.sha).toBe('dev');
  });

  it('defaults to "dev" when GIT_SHA is blank', () => {
    const svc = new AppVersionService(envMock('   '));
    expect(svc.sha).toBe('dev');
  });

  it('uses the injected GIT_SHA when set', () => {
    const svc = new AppVersionService(envMock('sha-abc1234'));
    expect(svc.sha).toBe('sha-abc1234');
  });
});
