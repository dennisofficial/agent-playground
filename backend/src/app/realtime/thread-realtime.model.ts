import { type ModelConfig, RealtimeRuleGuard, type Row } from '@workspace/pg-realtime';
import { deriveNeedsYou } from '../domain/thread';

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
  threadId: string;
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
class ThreadOrgGuard extends RealtimeRuleGuard<RealtimePrincipal, ThreadRealtimeRow> {
  canRead(user: RealtimePrincipal | null): { orgId: { $in: string[] } } | false {
    if (!user || user.orgIds.length === 0) return false;
    return { orgId: { $in: user.orgIds } };
  }
}

function mapRow(raw: Row): ThreadRealtimeRow {
  const status = String(raw.status);
  const turnActive = raw.turn_active === true;
  const createdAt = raw.created_at;
  return {
    threadId: String(raw.id),
    title: (raw.title as string | null) ?? null,
    origin: String(raw.origin),
    status,
    turnActive,
    needsYou: deriveNeedsYou(status, turnActive),
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    orgId: String(raw.org_id),
    repoId: String(raw.repo_id),
  };
}

/** The single model the realtime engine serves: the `threads` table, scoped per-org, projected flat. */
export const THREADS_MODEL: ModelConfig<ThreadRealtimeRow> = {
  table: 'threads',
  primaryKey: 'id',
  mapRow,
  guard: new ThreadOrgGuard(),
};
