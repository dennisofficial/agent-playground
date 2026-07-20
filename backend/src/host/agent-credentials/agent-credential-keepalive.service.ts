import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EAgentCredentialKind, EAgentCredentialStatus } from '@workspace/shared';
import { LessThan } from 'typeorm';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialRepo } from './entities/agent-credential.entity';

const REFRESH_WINDOW_MS = 35 * 60 * 1000;

/**
 * Proactively refreshes personal accounts before they expire, so a turn never starts on a stale token.
 * Safe to run on every instance: `ensureFresh` serializes on a pessimistic row lock and re-checks
 * freshness under it, so at most one refresh actually hits the token endpoint per window. Skips the test
 * DB so the suite never makes live OAuth calls.
 */
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
