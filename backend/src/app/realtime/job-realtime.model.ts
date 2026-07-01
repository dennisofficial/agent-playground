import {
  type ModelConfig,
  RealtimeRuleGuard,
  type Row,
} from '@workspace/pg-realtime';
import { deriveNeedsYou } from '../domain/job';

/**
 * The authenticated principal handed to the realtime guard — resolved by the SSE endpoint from the
 * cookie session (the user + the orgs they belong to). The guard scopes every streamed row to these
 * orgs, so a subscription can only ever see threads in the caller's own organizations.
 */
export interface RealtimePrincipal {
  userId: string;
  orgIds: string[];
}

/**
 * The realtime `threads` row pushed to the web sidebar. A FLAT projection of the `threads` table (the
 * WAL gives us one row, no joins) — it carries `orgId`/`repoId` (the frontend already knows the org/repo
 * display names from its own caches) plus the server-owned status signal. `needsYou` is derived by the
 * SAME `deriveNeedsYou` the REST list uses, so the live row and the fetched row always agree.
 *
 * NOTE: mingo matches the guard scope against THIS mapped shape (not the raw row), so `orgId` MUST be
 * present here for `ThreadOrgGuard` to scope by it.
 */
export interface ThreadRealtimeRow extends Row {
  jobId: string;
  title: string | null;
  origin: string;
  status: string;
  turnActive: boolean;
  needsYou: boolean;
  createdAt: string;
  orgId: string;
  repoId: string;
}

/** Row-level scope: a user may stream only threads belonging to an org they are a member of. */
class ThreadOrgGuard extends RealtimeRuleGuard<
  RealtimePrincipal,
  ThreadRealtimeRow
> {
  canRead(
    user: RealtimePrincipal | null,
  ): { orgId: { $in: string[] } } | false {
    if (!user || user.orgIds.length === 0) return false;
    return { orgId: { $in: user.orgIds } };
  }
}

function mapRow(raw: Row): ThreadRealtimeRow {
  const status = String(raw.status);
  const turnActive = raw.turn_active === true;
  // The durable human-input gate (see `deriveNeedsYou`): how many `ask_question` cards await the operator.
  // `SELECT *` snapshots and the WAL new-row image both carry this small (never-TOASTed) column, so it is
  // always present here; opening/answering a question updates the thread row → fires a realtime delta.
  const awaitingQuestion = Number(raw.open_question_count ?? 0) > 0;
  const createdAt = raw.created_at;
  return {
    jobId: String(raw.id),
    title: (raw.title as string | null) ?? null,
    origin: String(raw.origin),
    status,
    turnActive,
    needsYou: deriveNeedsYou(status, turnActive, awaitingQuestion),
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    orgId: String(raw.org_id),
    repoId: String(raw.repo_id),
  };
}

/** The single model the realtime engine serves: the `threads` table, scoped per-org, projected flat. */
export const THREADS_MODEL: ModelConfig<ThreadRealtimeRow> = {
  table: 'jobs',
  primaryKey: 'id',
  mapRow,
  guard: new ThreadOrgGuard(),
};
