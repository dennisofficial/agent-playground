import type { EnvService } from '@core/config/env/env.service';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantView } from '@workspace/shared';
import { TenantViewStore } from '../../harness/tenants/tenant-view.store';
import { AdminTokenGuard } from './admin-token.guard';
import { TenantsController } from './tenants.controller';

const TOKEN = 'test-admin-token';

const SAMPLE_TENANTS: TenantView[] = [
  { id: 'T001', name: 'Acme Corp', slug: 'T001' },
  { id: 'T002', name: 'Beta Inc', slug: 'T002' },
];

const mockStore = {
  list: vi.fn().mockResolvedValue(SAMPLE_TENANTS),
};

/**
 * Build a minimal Nest app with the real `AdminTokenGuard` + `TenantsController`,
 * but a mocked `TenantViewStore` — no DB required. Tests guard behavior + response
 * shape without standing up the full AppModule.
 */
async function buildApp(token?: string): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [TenantsController],
    providers: [
      {
        provide: TenantViewStore,
        useValue: mockStore,
      },
      AdminTokenGuard,
      {
        provide: 'EnvService' as unknown as symbol,
        useValue: {
          get: (k: string) => (k === 'ADMIN_API_TOKEN' ? token : undefined),
        },
      },
    ],
  })
    .overrideProvider(AdminTokenGuard)
    .useValue(
      new AdminTokenGuard({
        get: (k: string) => (k === 'ADMIN_API_TOKEN' ? token : undefined),
      } as unknown as EnvService),
    )
    .compile();

  const app = module.createNestApplication();
  await app.init();
  return app;
}

describe('TenantsController (e2e)', () => {
  let appWithToken: INestApplication;
  let appNoToken: INestApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    appWithToken = await buildApp(TOKEN);
    appNoToken = await buildApp(undefined);
  });

  // ── guard behavior ────────────────────────────────────────────────────────────

  it('GET /tenants — 503 when ADMIN_API_TOKEN is unset', async () => {
    await request(appNoToken.getHttpServer()).get('/tenants').expect(503);
  });

  it('GET /tenants — 401 without a bearer', async () => {
    await request(appWithToken.getHttpServer()).get('/tenants').expect(401);
  });

  it('GET /tenants — 401 with a wrong bearer', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
  });

  // ── list ──────────────────────────────────────────────────────────────────────

  it('GET /tenants — 200 with valid bearer + response shape', async () => {
    const res = await request(appWithToken.getHttpServer())
      .get('/tenants')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    const body = res.body as TenantView[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      id: 'T001',
      name: 'Acme Corp',
      slug: 'T001',
    });
    expect(body[1]).toMatchObject({
      id: 'T002',
      name: 'Beta Inc',
      slug: 'T002',
    });
  });

  it('GET /tenants — calls store.list() with no arguments', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(mockStore.list).toHaveBeenCalledOnce();
    expect(mockStore.list).toHaveBeenCalledWith();
  });

  it('GET /tenants — returns empty array when no tenants exist', async () => {
    mockStore.list.mockResolvedValueOnce([]);
    const res = await request(appWithToken.getHttpServer())
      .get('/tenants')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(res.body).toEqual([]);
  });
});
