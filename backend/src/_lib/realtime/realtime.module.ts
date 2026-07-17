import { EnvService } from '@core/config/env/env.service';
import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { type EngineConfig, PgAdvisoryLockLeaderElector, PgNotifyBus } from '@workspace/pg-realtime';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { DataSource } from 'typeorm';
import { OrganizationMember } from '../../app/org/entities/organization-member.entity';
import { buildRealtimeModels } from './realtime.models';

// The single logical-replication slot + publication the engine manages, and the advisory-lock name
// electing the one WAL consumer across app replicas (pg-realtime-internal).
const RT_SLOT_NAME = 'pg_realtime_slot';
const RT_PUBLICATION_NAME = 'pg_realtime_pub';
const RT_LOCK_NAME = 'atlas_pg_realtime_leader';

/**
 * Direct (non-pooler) libpq DSN for the engine, elector, and NOTIFY bus — built from the same
 * `POSTGRES_*` env the app connects with. Atlas has no PgBouncer in front of Postgres, so the app DSN
 * is already a direct connection, which logical replication + LISTEN both require. App-specific (reads
 * Atlas env, tags `application_name`), so it lives here rather than in the generic pg-realtime package.
 */
function buildConnectionString(env: EnvService): string {
  const user = encodeURIComponent(env.get('POSTGRES_USER'));
  const password = encodeURIComponent(env.get('POSTGRES_PASSWORD'));
  const appName = encodeURIComponent('atlas (pg-realtime)');
  return `postgresql://${user}:${password}@${env.get('POSTGRES_HOST')}:${env.get('POSTGRES_PORT')}/${env.get('POSTGRES_DB')}?application_name=${appName}`;
}

/**
 * Wires the pg-realtime engine — **infrastructure, not a feature module**, so it lives in `_lib`
 * alongside DatabaseModule / RedisModule. `consume: true` + an advisory-lock leader means exactly one
 * replica reads the WAL slot (pg-realtime's own advisory lock — the one legitimate lock, unrelated to
 * app coordination), while every replica LISTENs on the NOTIFY bus and serves SSE. Single-instance
 * today, horizontally scalable unchanged. `PgRealtimeModule` is global, so `PG_REALTIME_ENGINE` is
 * injectable app-wide once this is imported.
 */
@Module({
  imports: [
    PgRealtimeModule.forRootAsync({
      inject: [EnvService, getDataSourceToken()],
      useFactory: (env: EnvService, dataSource: DataSource): EngineConfig => {
        const connectionString = buildConnectionString(env);
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
