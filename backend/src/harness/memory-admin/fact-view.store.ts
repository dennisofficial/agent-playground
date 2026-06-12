import { type FactListResponse, type FactView } from '@workspace/shared';
import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { parseScope, type Tier } from '../domain/identity';
import { rawRows, toIso } from '../memory/sql';

export interface FactFilter {
  /** Restrict to one sharing tier. */
  tier?: Tier;
  /** Exact project id — only relevant when `tier === 'project'`. */
  projectId?: string;
  /** Bot id to match against the agent segment of `bot:` and `pair:` scopes. */
  botId?: string;
  /** Filter by the human who stated the fact (`asserted_by` column). */
  assertedBy?: string;
  /** Optional server-side substring filter (primary search is client-side). */
  q?: string;
  /** Include soft-deleted facts. Default: false. */
  includeDeleted?: boolean;
  /** Include facts with `team_id IS NULL` (global/promoted). Default: true. */
  includeGlobal?: boolean;
  /** Max items to return. Capped at 200. Default: 50. */
  limit?: number;
  /** Zero-based offset. Default: 0. */
  offset?: number;
  /** Sort by last-updated or created time, DESC. Default: 'updated'. */
  sort?: 'updated' | 'created';
}

interface FactRawRow {
  id: number | string;
  fact: string;
  scope: string;
  team_id: string | null;
  confidence: number | string;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
}

function toFactView(r: FactRawRow): FactView {
  const parsed = parseScope(r.scope);
  return {
    id: Number(r.id),
    content: r.fact,
    tier: parsed.tier,
    botId: parsed.botId ?? null,
    projectId: parsed.projectId ?? null,
    humanId: parsed.humanId ?? null,
    confidence: Number(r.confidence),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    deletedAt: r.deleted_at != null ? toIso(r.deleted_at) : null,
  };
}

const SELECT_COLS = `id, fact, scope, team_id, confidence, created_at, updated_at, deleted_at`;

const TIER_PREFIX: Record<Tier, string> = {
  team: 'team:',
  project: 'project:',
  bot: 'bot:',
  private: 'pair:',
};

/**
 * Read-only god-view over the `facts` table for the admin Memory Viewer. No scope-guarding
 * (admin bearer is the only gate), no embedding columns ever returned.
 *
 * Slim, harness-free — takes a `Repository<Fact>` directly; zero LLM/employee dependencies.
 * All writes and agent-facing reads go through `SemanticMemory` (separate service).
 */
export class FactViewStore {
  constructor(private readonly repo: Repository<Fact>) {}

  private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    return rawRows<T>(await this.repo.manager.query(sql, params));
  }

  /**
   * Filtered, paginated list of facts for a tenant. Returns `{ items, total, limit, offset }`
   * so the client can compute pagination controls and the forgotten-count hint without a
   * second request.
   */
  async list(
    teamId: string,
    filter: FactFilter = {},
  ): Promise<FactListResponse> {
    const args: unknown[] = [teamId];
    const where: string[] = [];

    // --- tenant + global ---
    // `includeGlobal` defaults to true — mirrors agent recall semantics (global facts are
    // recalled in every workspace).
    if (filter.includeGlobal !== false) {
      where.push(`(team_id = $1 OR team_id IS NULL)`);
    } else {
      where.push(`team_id = $1`);
    }

    // --- soft-delete ---
    if (!filter.includeDeleted) {
      where.push(`deleted_at IS NULL`);
    }

    // --- tier filter ---
    // Use starts_with() not LIKE — bot/human ids can contain `_` which LIKE treats as a wildcard.
    if (filter.tier) {
      args.push(TIER_PREFIX[filter.tier]);
      where.push(`starts_with(scope, $${args.length})`);
    }

    // --- projectId (exact scope) ---
    // Supersedes the tier prefix when both are given (more specific wins).
    if (filter.projectId) {
      args.push(`project:${filter.projectId}`);
      where.push(`scope = $${args.length}`);
    }

    // --- botId: matches bot:{id} exactly OR pair:{id}:{human} ---
    // starts_with(scope, 'pair:{id}:') is safe even when botId contains underscores.
    if (filter.botId) {
      args.push(`bot:${filter.botId}`);
      args.push(`pair:${filter.botId}:`);
      where.push(
        `(scope = $${args.length - 1} OR starts_with(scope, $${args.length}))`,
      );
    }

    // --- assertedBy: the human who stated the fact ---
    if (filter.assertedBy) {
      args.push(filter.assertedBy);
      where.push(`asserted_by = $${args.length}`);
    }

    // --- substring text search (server-side optional; primary search is client-side) ---
    // Escape ILIKE metacharacters in the user-supplied string before wrapping with %.
    if (filter.q) {
      const escaped = filter.q
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      args.push(`%${escaped}%`);
      // E'\\' is the PostgreSQL E-string literal for a single backslash — the ESCAPE character.
      where.push(`fact ILIKE $${args.length} ESCAPE E'\\\\'`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // --- count (no limit/offset) ---
    const countRows = await this.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facts ${whereClause}`,
      [...args],
    );
    const total = Number(countRows[0]?.n ?? 0);

    // --- data ---
    const sortCol = filter.sort === 'created' ? 'created_at' : 'updated_at';
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const dataArgs = [...args, limit, offset];
    const rows = await this.query<FactRawRow>(
      `SELECT ${SELECT_COLS}
       FROM facts
       ${whereClause}
       ORDER BY ${sortCol} DESC
       LIMIT $${dataArgs.length - 1} OFFSET $${dataArgs.length}`,
      dataArgs,
    );

    return { items: rows.map(toFactView), total, limit, offset };
  }

  /**
   * Single fact by row id — cross-scope admin god-view. Includes soft-deleted facts (the
   * caller may want to inspect a forgotten fact by id). Returns null if the id doesn't exist
   * or belongs to a different tenant.
   */
  async get(teamId: string, id: number): Promise<FactView | null> {
    const rows = await this.query<FactRawRow>(
      `SELECT ${SELECT_COLS}
       FROM facts
       WHERE id = $1 AND (team_id = $2 OR team_id IS NULL)`,
      [id, teamId],
    );
    return rows[0] ? toFactView(rows[0]) : null;
  }
}
