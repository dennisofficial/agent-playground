import { EnvService } from '@core/config/env/env.service';
import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { type EngineConfig, PgAdvisoryLockLeaderElector, PgNotifyBus } from '@workspace/pg-realtime';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { DataSource } from 'typeorm';
import {
  buildRealtimeConnectionString,
  RT_LOCK_NAME,
  RT_PUBLICATION_NAME,
  RT_SLOT_NAME,
} from '../../_lib/realtime/realtime.connection';
import { OrganizationMember } from '../org/entities/organization-member.entity';
import { buildRealtimeModels } from './realtime.models';

/**
 * Wires the pg-realtime engine for the single `app` process. `consume: true` + an advisory-lock
 * leader elector means: exactly one replica reads the WAL slot (pg-realtime's own advisory lock —
 * the one legitimate lock, unrelated to app coordination), while every replica LISTENs on the
 * Postgres NOTIFY bus and serves SSE. Single-instance today, horizontally scalable unchanged.
 *
 * `PgRealtimeModule` is global, so `PG_REALTIME_ENGINE` is injectable app-wide once this module is
 * imported. Guards resolve org membership through the default DataSource at subscription time.
 */
@Module({
  imports: [
    PgRealtimeModule.forRootAsync({
      inject: [EnvService, getDataSourceToken()],
      useFactory: (env: EnvService, dataSource: DataSource): EngineConfig => {
        const connectionString = buildRealtimeConnectionString(env);
        return {
          connectionString,
          slotName: RT_SLOT_NAME,
          publicationName: RT_PUBLICATION_NAME,
          consume: true,
          leader: new PgAdvisoryLockLeaderElector({ connectionString, lockName: RT_LOCK_NAME }),
          bus: new PgNotifyBus({ connectionString }),
          models: buildRealtimeModels(dataSource.getRepository(OrganizationMember)),
        };
      },
    }),
  ],
})
export class RealtimeModule {}
