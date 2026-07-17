import type { EnvService } from '@core/config/env/env.service';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { JobEntity } from '../../persistence/entities';
import type { SandboxProvider } from '../../sandbox/sandbox-provider.port';
import type { CaddyAdminClient } from '../caddy-admin.client';
import { ExposureService } from '../exposure.service';

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

function makeService(
  provider: Partial<SandboxProvider>,
  options: { previewBaseDomain?: string | null } = {},
) {
  const previewBaseDomain =
    options.previewBaseDomain === undefined ? 'example.com' : options.previewBaseDomain;
  const caddy = {
    deleteRoutesByPrefix: vi.fn(async () => undefined),
    unbridgeCaddyFromSandbox: vi.fn(async () => undefined),
    upsertRoute: vi.fn(async () => undefined),
    listRouteIds: vi.fn(async () => [] as string[]),
    deleteRoute: vi.fn(async () => undefined),
  } as unknown as CaddyAdminClient;
  const env = {
    get: (key: string) => {
      if (key === 'PREVIEW_BASE_DOMAIN') return previewBaseDomain ?? undefined;
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
  return { svc, caddy };
}

describe('ExposureService.reconcile — port_state', () => {
  it('persists internal when a service is running and preview exposure is disabled', async () => {
    const startedAt = '2026-07-10T00:00:00Z';
    const dir = mkdtempSync(join(tmpdir(), 'atlas-exposure-'));
    try {
      writeFileSync(
        join(dir, 'web.json'),
        JSON.stringify({
          name: 'web',
          cmd: 'pnpm dev',
          pid: 10,
          pgid: 10,
          startedAt,
          port: 3000,
          expose: true,
        }),
      );
      const { qb, calls } = fakeQueryBuilder();
      const createQueryBuilder = vi.fn(() => qb);
      const provider: Partial<SandboxProvider> = {
        supervisorDirHost: vi.fn(() => dir),
        probeLiveness: vi.fn(async () => ({
          status: 'up' as const,
          containerStartedAt: startedAt,
          alive: [10],
        })),
      };
      const { svc, caddy } = makeService(provider, { previewBaseDomain: null });
      (svc as any).jobs = { createQueryBuilder };

      await svc.reconcile('job-1');

      expect(calls.set).toEqual({ port_state: 'internal' });
      expect(calls.where).toEqual([
        'id = :id AND port_state IS DISTINCT FROM :ps',
        { id: 'job-1', ps: 'internal' },
      ]);
      expect(caddy.upsertRoute).not.toHaveBeenCalled();
      expect(caddy.deleteRoutesByPrefix).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ExposureService.reconcileAll — port_state teardown sweep', () => {
  it('clears non-live jobs, scoping the sweep to the live set', async () => {
    const { qb, calls } = fakeQueryBuilder();
    const createQueryBuilder = vi.fn(() => qb);
    const provider: Partial<SandboxProvider> = {
      listLiveThreadJobIds: vi.fn(async () => ['a', 'b']),
      supervisorDirHost: vi.fn(() => '/tmp/does-not-exist-atlas-svc-fixture'),
      probeLiveness: vi.fn(async () => ({ status: 'down' }) as const),
    };
    const { svc } = makeService(provider);
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
    const { svc } = makeService(provider);
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
    const { svc } = makeService(provider);
    (svc as any).jobs = { createQueryBuilder };

    await svc.reconcileAll();

    expect(createQueryBuilder).not.toHaveBeenCalled();
  });
});
