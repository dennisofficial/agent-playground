import { type TenantView } from '@workspace/shared';
import { Tenant } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows } from '../memory/sql';

interface TenantRow {
  team_id: string;
  team_name: string;
}

function toView(r: TenantRow): TenantView {
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
  async list(): Promise<TenantView[]> {
    const rows = rawRows<TenantRow>(
      await this.repo.manager.query(
        `SELECT team_id, team_name FROM tenants ORDER BY team_name`,
        [],
      ),
    );
    return rows.map(toView);
  }
}
