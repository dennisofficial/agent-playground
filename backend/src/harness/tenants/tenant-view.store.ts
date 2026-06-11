import { Tenant } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows } from '../memory/sql';

/**
 * A lightweight workspace summary for admin UI navigation.
 *
 * `slug` is the same value as `id` (the Slack `team_id`): there is no separate slug column in the
 * `tenants` table, and the Slack team ID already serves as the canonical URL-safe unique identifier
 * for a workspace throughout the system. If a human-readable slug is needed in a future iteration,
 * a column migration is the right fix — not a derived string.
 */
export interface TenantSummary {
  /** Slack team id — the `:teamId` path param in all tenant-scoped endpoints. */
  id: string;
  /** Human-readable workspace display name. */
  name: string;
  /** URL-safe workspace identifier (same as `id` — see jsdoc above). */
  slug: string;
}

interface TenantRow {
  team_id: string;
  team_name: string;
}

function toSummary(r: TenantRow): TenantSummary {
  return {
    id: r.team_id,
    name: r.team_name,
    slug: r.team_id,
  };
}

/**
 * Read-only tenant directory — powers the workspace picker in the Memory Viewer.
 * Slim, harness-free. No token/secret columns are ever selected.
 */
export class TenantViewStore {
  constructor(private readonly repo: Repository<Tenant>) {}

  /** All registered workspaces, sorted by display name. */
  async list(): Promise<TenantSummary[]> {
    const rows = rawRows<TenantRow>(
      await this.repo.manager.query(
        `SELECT team_id, team_name FROM tenants ORDER BY team_name`,
        [],
      ),
    );
    return rows.map(toSummary);
  }
}
