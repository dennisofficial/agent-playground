import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import pg from 'pg';
import type { Subscription } from 'rxjs';
import { LeaderElectionService } from '../cluster/leader-election.service';
import { pgConnectionString, resolveSsl } from '../persistence/database.module';
import { SECTION_STAMP_DDL } from './section-stamp.constants';

/**
 * Boot-reconciled installer for the `jobs_stamp_section_entered` trigger (see
 * `section-stamp.constants.ts` + `JobEntity.section_first_entered`). LEADER-ONLY, like
 * `RealtimeService`'s engine: DDL only needs to run once per promotion, not per instance. FAIL-SOFT —
 * this is a data-integrity nicety (self-heals on the next leader promotion / restart, and the
 * `AddJobSectionFirstEntered` migration's backfill already covers historical rows), not a hard boot
 * dependency, so a failure here logs a warning instead of crashing boot.
 */
@Injectable()
export class SectionStampService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SectionStampService.name);
  private promoteSub?: Subscription;

  constructor(
    private readonly env: EnvService,
    private readonly election: LeaderElectionService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('POSTGRES_DB')?.endsWith('_test')) return;
    this.promoteSub = this.election.onPromote(() => void this.ensure());
  }

  onApplicationShutdown(): void {
    this.promoteSub?.unsubscribe();
  }

  private async ensure(): Promise<void> {
    const client = new pg.Client({
      connectionString: pgConnectionString(this.env),
      ssl: resolveSsl(this.env),
      application_name: 'atlas-section-stamp-ddl',
    });
    try {
      await client.connect();
      await client.query(SECTION_STAMP_DDL);
      this.logger.log('section_first_entered stamp trigger reconciled');
    } catch (err) {
      this.logger.warn(
        `failed to install section-stamp trigger: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
