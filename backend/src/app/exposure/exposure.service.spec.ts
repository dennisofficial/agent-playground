import { describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { JobEntity } from '../persistence/entities';
import type { CaddyAdminClient } from './caddy-admin.client';
import { ExposureService } from './exposure.service';

/** A chainable query-builder stub that records every `.where`/`.andWhere` call + the `.set` payload. */
function fakeQueryBuilder() {
  const calls = {
    set: undefined as unknown,
    where: undefined as [string, unknown] | undefined,
    andWhere: undefined as [string, unknown] | undefined,
  };
  const qb = {
    update: vi.fn(() => qb),
    set: vi.fn((v: unknown) => {
      calls.set = v;
      return qb;
    }),
    where: vi.fn((cond: string, params?: unknown) => {
      calls.where = [cond, params];
      return qb;
    }),
    andWhere: vi.fn((cond: string, params?: unknown) => {
      calls.andWhere = [cond, params];
      return qb;
    }),
    execute: vi.fn(async () => undefined),
  };
  return { qb, calls };
}

function makeService(provider: Partial<SandboxProvider>) {
  const caddy = {
    deleteRoutesByPrefix: vi.fn(async () => undefined),
    unbridgeCaddyFromSandbox: vi.fn(async () => undefined),
    upsertRoute: vi.fn(async () => undefined),
    listRouteIds: vi.fn(async () => [] as string[]),
    deleteRoute: vi.fn(async () => undefined),
  } as unknown as CaddyAdminClient;
  const env = {
    get: (key: string) => {
      if (key === 'PREVIEW_BASE_DOMAIN') return 'example.com';
      if (key === 'PREVIEW_ID_SECRET') return 'preview-secret';
      if (key === 'SECRETS_ENCRYPTION_KEY') return 'secrets-key';
      return undefined;
    },
  } as unknown as EnvService;
  const svc = new ExposureService(
    provider as SandboxProvider,
    caddy,
    env,
    undefined as unknown as Repository<JobEntity>,
  );
  return svc;
}

describe('ExposureService.reconcileAll — port_state teardown sweep', () => {
  it('clears non-live jobs, scoping the sweep to the live set', async () => {
    const { qb, calls } = fakeQueryBuilder();
    const createQueryBuilder = vi.fn(() => qb);
    const provider: Partial<SandboxProvider> = {
      listLiveThreadJobIds: vi.fn(async () => ['a', 'b']),
      supervisorDirHost: vi.fn(() => '/tmp/does-not-exist-atlas-svc-fixture'),
      probeLiveness: vi.fn(async () => ({ status: 'down' }) as const),
    };
    const svc = makeService(provider);
    (svc as any).jobs = { createQueryBuilder };

    await svc.reconcileAll();

    expect(createQueryBuilder).toHaveBeenCalled();
    expect(calls.set).toEqual({ port_state: null });
    expect(calls.where).toEqual(['port_state IS NOT NULL', undefined]);
    expect(calls.andWhere).toEqual(['id NOT IN (:...live)', { live: ['a', 'b'] }]);
    expect(qb.execute).toHaveBeenCalled();
  });

  it('clears ALL non-null jobs when nothing is live (no andWhere)', async () => {
    const { qb, calls } = fakeQueryBuilder();
    const createQueryBuilder = vi.fn(() => qb);
    const provider: Partial<SandboxProvider> = {
      listLiveThreadJobIds: vi.fn(async () => []),
      supervisorDirHost: vi.fn(() => '/tmp/does-not-exist-atlas-svc-fixture'),
      probeLiveness: vi.fn(async () => ({ status: 'down' }) as const),
    };
    const svc = makeService(provider);
    (svc as any).jobs = { createQueryBuilder };

    await svc.reconcileAll();

    expect(calls.set).toEqual({ port_state: null });
    expect(calls.where).toEqual(['port_state IS NOT NULL', undefined]);
    expect(calls.andWhere).toBeUndefined();
    expect(qb.execute).toHaveBeenCalled();
  });

  it('skips the tick entirely (no sweep query) when listLiveThreadJobIds throws', async () => {
    const createQueryBuilder = vi.fn();
    const provider: Partial<SandboxProvider> = {
      listLiveThreadJobIds: vi.fn(async () => {
        throw new Error('transient');
      }),
      supervisorDirHost: vi.fn(() => '/tmp/does-not-exist-atlas-svc-fixture'),
      probeLiveness: vi.fn(async () => ({ status: 'down' }) as const),
    };
    const svc = makeService(provider);
    (svc as any).jobs = { createQueryBuilder };

    await svc.reconcileAll();

    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});
