import { EnvService } from '@core/config/env/env.service';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactView } from '@workspace/shared';
import { FactViewStore } from '../../harness/memory-admin/fact-view.store';
import { AdminTokenGuard } from './admin-token.guard';
import { MemoryFactsController } from './memory.controller';

const TOKEN = 'test-admin-token';

const SAMPLE_FACT: FactView = {
  id: 1,
  content: 'Alex prefers TypeScript',
  tier: 'bot',
  botId: 'alex',
  projectId: null,
  humanId: null,
  confidence: 1.0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  deletedAt: null,
};

const mockStore = {
  list: vi.fn().mockResolvedValue({
    items: [SAMPLE_FACT],
    total: 1,
    limit: 50,
    offset: 0,
  }),
  get: vi.fn().mockResolvedValue(SAMPLE_FACT),
};

/**
 * Build a minimal Nest app with the real `AdminTokenGuard` + `MemoryFactsController`,
 * but a mocked `FactViewStore` — no DB required. Tests guard behavior + DTO validation
 * + response shape without standing up the full AppModule.
 */
async function buildApp(token?: string): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [MemoryFactsController],
    providers: [
      {
        provide: FactViewStore,
        useValue: mockStore,
      },
      { provide: APP_GUARD, useClass: AdminTokenGuard },
      {
        // Provide EnvService under its real class token so AdminTokenGuard's constructor
        // injection resolves; `ADMIN_API_TOKEN` drives the guard's enabled/valid checks.
        provide: EnvService,
        useValue: {
          get: (k: string) => (k === 'ADMIN_API_TOKEN' ? token : undefined),
        },
      },
    ],
  }).compile();

  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

describe('MemoryFactsController (e2e)', () => {
  let appWithToken: INestApplication;
  let appNoToken: INestApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    appWithToken = await buildApp(TOKEN);
    appNoToken = await buildApp(undefined);
  });

  // ── guard behavior ────────────────────────────────────────────────────────────

  it('GET /tenants/:teamId/memory/facts — 503 when ADMIN_API_TOKEN is unset', async () => {
    await request(appNoToken.getHttpServer())
      .get('/tenants/local/memory/facts')
      .expect(503);
  });

  it('GET /tenants/:teamId/memory/facts — 401 without a bearer', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts')
      .expect(401);
  });

  it('GET /tenants/:teamId/memory/facts — 401 with a wrong bearer', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts')
      .set('Authorization', 'Bearer wrong-token')
      .expect(401);
  });

  // ── list ──────────────────────────────────────────────────────────────────────

  it('GET /tenants/:teamId/memory/facts — 200 with valid bearer + response shape', async () => {
    const res = await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(res.body).toMatchObject({
      items: [
        {
          id: 1,
          content: 'Alex prefers TypeScript',
          tier: 'bot',
          botId: 'alex',
          projectId: null,
          humanId: null,
          confidence: 1.0,
          deletedAt: null,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    // Raw scope must never appear in the response
    const firstItem = (res.body as { items: Record<string, unknown>[] })
      .items[0];
    expect(firstItem).not.toHaveProperty('scope');
    expect(firstItem).not.toHaveProperty('embedding');
  });

  it('GET /tenants/:teamId/memory/facts — passes query params to the store', async () => {
    await request(appWithToken.getHttpServer())
      .get(
        '/tenants/local/memory/facts?tier=bot&botId=alex&includeDeleted=true&limit=10&offset=5&sort=created',
      )
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(mockStore.list).toHaveBeenCalledWith('local', {
      tier: 'bot',
      botId: 'alex',
      includeDeleted: true,
      limit: 10,
      offset: 5,
      sort: 'created',
    });
  });

  it('GET /tenants/:teamId/memory/facts — 400 on invalid tier', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts?tier=invalid')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(400);
  });

  it('GET /tenants/:teamId/memory/facts — 400 on limit > 200', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts?limit=201')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(400);
  });

  it('GET /tenants/:teamId/memory/facts — 400 on negative offset', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts?offset=-1')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(400);
  });

  it('GET /tenants/:teamId/memory/facts — 400 on invalid sort value', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts?sort=desc')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(400);
  });

  // ── get single ───────────────────────────────────────────────────────────────

  it('GET /tenants/:teamId/memory/facts/:id — 200 with valid id', async () => {
    const res = await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts/1')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);

    expect(res.body).toMatchObject({
      id: 1,
      content: 'Alex prefers TypeScript',
    });
    expect(mockStore.get).toHaveBeenCalledWith('local', 1);
  });

  it('GET /tenants/:teamId/memory/facts/:id — 404 when store returns null', async () => {
    mockStore.get.mockResolvedValueOnce(null);
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts/999')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(404);
  });

  it('GET /tenants/:teamId/memory/facts/:id — 404 on non-integer id', async () => {
    await request(appWithToken.getHttpServer())
      .get('/tenants/local/memory/facts/abc')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(404);
  });
});
