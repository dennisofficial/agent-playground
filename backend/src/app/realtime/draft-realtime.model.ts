import { type ModelConfig, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import type { RealtimePrincipal } from './job-realtime.model';

/**
 * The realtime `composer_drafts` row pushed to the owner's own devices. Deliberately a FLAT projection
 * with NO `payload` field: the client reacts to a delta by refetching `GET /draft` (which already returns
 * the decrypted wire payload + attachment list), so a staged secret's plaintext never traverses the WAL.
 */
export interface DraftRealtimeRow extends Row {
  id: string;
  jobId: string;
  userId: string;
  orgId: string;
  updatedAt: string;
}

function mapRow(raw: Row): DraftRealtimeRow {
  const updatedAt = raw.updated_at;
  return {
    id: String(raw.id),
    jobId: String(raw.job_id),
    userId: String(raw.user_id),
    orgId: String(raw.org_id),
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt),
  };
}

/** Row-level scope: a user may stream only their own drafts. */
class DraftUserGuard extends RealtimeRuleGuard<RealtimePrincipal, DraftRealtimeRow> {
  canRead(user: RealtimePrincipal | null): { userId: string } | false {
    return user ? { userId: user.userId } : false;
  }
}

/** The single model the realtime engine serves for drafts: the `composer_drafts` table, scoped per-user,
 *  projected flat. `refetchOnUpdate` is cheap insurance against pgoutput omitting an unchanged TOASTed
 *  jsonb payload — moot here since `payload` isn't projected, but kept for parity with `THREADS_MODEL`. */
export const DRAFTS_MODEL: ModelConfig<DraftRealtimeRow> = {
  table: 'composer_drafts',
  primaryKey: 'id',
  refetchOnUpdate: true,
  mapRow,
  guard: new DraftUserGuard(),
};
