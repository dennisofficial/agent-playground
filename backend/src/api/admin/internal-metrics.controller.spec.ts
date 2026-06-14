import { EnvService } from '@core/config/env/env.service';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { IInternalMetricsResponse } from '@workspace/shared';
import request from 'supertest';
import { MetricsEventsService } from '../../harness/metrics/metrics-events.service';
import { InternalMetricsController } from './internal-metrics.controller';

describe('InternalMetricsController', () => {
  let app: INestApplication;
  let summarizeByAgent: ReturnType<typeof vi.fn>;

  const response: IInternalMetricsResponse = {
    teamId: 'T1',
    projectId: 'proj',
    since: '2026-01-01T00:00:00.000Z',
    until: '2026-01-31T23:59:59.999Z',
    generatedAt: '2026-02-01T00:00:00.000Z',
    agents: [
      {
        agentId: 'alex',
        executionCompleted: 2,
        executionBlocked: 1,
        executionSuccessRate: 2 / 3,
      },
    ],
  };

  beforeEach(async () => {
    summarizeByAgent = vi.fn().mockResolvedValue(response);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [InternalMetricsController],
      providers: [
        {
          provide: MetricsEventsService,
          useValue: { summarizeByAgent },
        },
        {
          provide: EnvService,
          useValue: {
            get: (key: string) =>
              key === 'ADMIN_API_TOKEN' ? 'admin-token' : undefined,
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns internal metrics for valid tenant params', async () => {
    await request(app.getHttpServer())
      .get('/tenants/T1/internal-metrics')
      .set('Authorization', 'Bearer admin-token')
      .expect(200)
      .expect(response);

    expect(summarizeByAgent).toHaveBeenCalledWith({
      teamId: 'T1',
      projectId: undefined,
      since: undefined,
      until: undefined,
    });
  });

  it('rejects requests missing the admin token', async () => {
    await request(app.getHttpServer())
      .get('/tenants/T1/internal-metrics')
      .expect(401);

    expect(summarizeByAgent).not.toHaveBeenCalled();
  });

  it('forwards optional project and date query params to the service', async () => {
    await request(app.getHttpServer())
      .get('/tenants/T1/internal-metrics')
      .query({
        projectId: 'proj',
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-01-31T23:59:59.999Z',
      })
      .set('Authorization', 'Bearer admin-token')
      .expect(200);

    expect(summarizeByAgent).toHaveBeenCalledWith({
      teamId: 'T1',
      projectId: 'proj',
      since: new Date('2026-01-01T00:00:00.000Z'),
      until: new Date('2026-01-31T23:59:59.999Z'),
    });
  });
});
