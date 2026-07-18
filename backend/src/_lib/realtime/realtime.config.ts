import { EnvService } from '@core/config/env/env.service';
import { PgAdvisoryLockLeaderElector, PgNotifyBus } from '@workspace/pg-realtime';
import type { RootEngineConfig } from '@workspace/pg-realtime/nest';

const RT_SLOT_NAME = 'pg_realtime_slot';
const RT_PUBLICATION_NAME = 'pg_realtime_pub';
const RT_LOCK_NAME = 'atlas_pg_realtime_leader';

function buildConnectionString(env: EnvService): string {
  const user = encodeURIComponent(env.get('POSTGRES_USER'));
  const password = encodeURIComponent(env.get('POSTGRES_PASSWORD'));
  const appName = encodeURIComponent('atlas (pg-realtime)');
  return `postgresql://${user}:${password}@${env.get('POSTGRES_HOST')}:${env.get('POSTGRES_PORT')}/${env.get('POSTGRES_DB')}?application_name=${appName}`;
}

/**
 * Atlas's pg-realtime engine config, for `PgRealtimeModule.forRootAsync({ inject: [EnvService], useFactory:
 * atlasRealtimeConfig })`. Just the Postgres connection + slot/lock names — the models are added by each
 * `PgRealtimeModule.forFeature()` a feature module declares.
 */
export function atlasRealtimeConfig(env: EnvService): RootEngineConfig {
  const connectionString = buildConnectionString(env);
  return {
    connectionString,
    slotName: RT_SLOT_NAME,
    publicationName: RT_PUBLICATION_NAME,
    consume: true,
    leader: new PgAdvisoryLockLeaderElector({ connectionString, lockName: RT_LOCK_NAME }),
    bus: new PgNotifyBus({ connectionString }),
  };
}
