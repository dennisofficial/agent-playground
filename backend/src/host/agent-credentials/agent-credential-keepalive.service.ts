import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EAgentCredentialKind, EAgentCredentialStatus } from '@workspace/shared';
import { LessThan } from 'typeorm';
import { AgentCredentialRepo } from '../../_lib/database/entities/agent-credential.entity';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';

const REFRESH_WINDOW_MS = 35 * 60 * 1000;

@Injectable()
export class AgentCredentialKeepaliveService {
  private readonly logger = new Logger(AgentCredentialKeepaliveService.name);
  private readonly isTestDb: boolean;

  constructor(
    private readonly repo: AgentCredentialRepo,
    private readonly refresh: AgentCredentialRefreshService,
    env: EnvService,
  ) {
    this.isTestDb = /_test$/.test(env.get('POSTGRES_DB'));
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (this.isTestDb) return;
    const soon = new Date(Date.now() + REFRESH_WINDOW_MS);
    const rows = await this.repo.find({
      where: {
        kind: EAgentCredentialKind.PERSONAL,
        status: EAgentCredentialStatus.ACTIVE,
        expiresAt: LessThan(soon),
      },
      select: { id: true, orgId: true },
    });
    for (const row of rows) {
      try {
        await this.refresh.ensureFresh(row.orgId, row.id, REFRESH_WINDOW_MS);
      } catch (err) {
        this.logger.warn(`keepalive refresh failed for ${row.id}: ${String(err)}`);
      }
    }
  }
}
