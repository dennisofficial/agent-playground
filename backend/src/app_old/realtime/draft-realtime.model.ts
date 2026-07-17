import { type ModelConfig, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import type { RealtimePrincipal } from './job-realtime.model';

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

class DraftUserGuard extends RealtimeRuleGuard<RealtimePrincipal, DraftRealtimeRow> {
  canRead(user: RealtimePrincipal | null): { userId: string } | false {
    return user ? { userId: user.userId } : false;
  }
}

export const DRAFTS_MODEL: ModelConfig<DraftRealtimeRow> = {
  table: 'composer_drafts',
  primaryKey: 'id',
  refetchOnUpdate: true,
  mapRow,
  guard: new DraftUserGuard(),
};
