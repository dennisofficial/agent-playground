import type { EnvService } from '@core/config/env/env.service';

/** Shared names for the single logical-replication slot + publication pg-realtime manages. */
export const RT_SLOT_NAME = 'pg_realtime_slot';
export const RT_PUBLICATION_NAME = 'pg_realtime_pub';
/** Advisory-lock name electing the single WAL consumer across app replicas (pg-realtime-internal). */
export const RT_LOCK_NAME = 'atlas_pg_realtime_leader';

/**
 * Direct (non-pooler) libpq connection string for the realtime engine, the advisory-lock elector,
 * and the LISTEN/NOTIFY bus. Built from the same `POSTGRES_*` env the app connects with — Atlas has
 * no PgBouncer in front of Postgres, so the app DSN is already a direct connection (logical
 * replication + LISTEN both require that). `application_name` tags the connection for observability.
 */
export function buildRealtimeConnectionString(env: EnvService): string {
  const user = encodeURIComponent(env.get('POSTGRES_USER'));
  const password = encodeURIComponent(env.get('POSTGRES_PASSWORD'));
  const host = env.get('POSTGRES_HOST');
  const port = env.get('POSTGRES_PORT');
  const db = env.get('POSTGRES_DB');
  const appName = encodeURIComponent('atlas (pg-realtime)');
  return `postgresql://${user}:${password}@${host}:${port}/${db}?application_name=${appName}`;
}
