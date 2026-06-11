import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Tenant } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';

export type TenantStatus = 'active' | 'suspended';

export interface TenantRecord {
  teamId: string;
  teamName: string;
  status: TenantStatus;
  installedBy: string | null;
}

interface TenantRow {
  team_id: string;
  team_name: string;
  status: TenantStatus;
  installed_by: string | null;
}

const toRecord = (r: TenantRow): TenantRecord => ({
  teamId: r.team_id,
  teamName: r.team_name,
  status: r.status,
  installedBy: r.installed_by,
});

const SELECT = `team_id, team_name, status, installed_by`;

/**
 * The workspace registry (raw-SQL house style), now in the SINGLE database alongside the harness
 * schema — installing the app is the only way a row appears (no stack, no provisioning). Bot tokens
 * are WRITE-ONLY: read paths return metadata, never ciphertext; `resolveBotTokenCiphertext()` is
 * the one decrypt-input seam (the ears WebClient builder), never logged or returned to a response.
 */
@Injectable()
export class TenantStore {
  constructor(
    @InjectRepository(Tenant) private readonly repo: Repository<Tenant>,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<TenantRow[]> {
    return (await this.repo.manager.query(sql, params)) as TenantRow[];
  }

  /** Install/reinstall: insert or refresh name + token ciphertext + installer (active on install). */
  async upsertFromOauth(input: {
    teamId: string;
    teamName: string;
    botTokenCiphertext: string;
    installedBy?: string;
  }): Promise<TenantRecord> {
    const rows = await this.q(
      `INSERT INTO tenants (team_id, team_name, status, bot_token_ciphertext, installed_by)
       VALUES ($1, $2, 'active', $3, $4)
       ON CONFLICT (team_id) DO UPDATE SET
         team_name = EXCLUDED.team_name,
         bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
         installed_by = EXCLUDED.installed_by,
         status = 'active',
         updated_at = now()
       RETURNING ${SELECT}`,
      [input.teamId, input.teamName, input.botTokenCiphertext, input.installedBy ?? null],
    );
    return toRecord(rows[0]);
  }

  async get(teamId: string): Promise<TenantRecord | undefined> {
    const rows = await this.q(`SELECT ${SELECT} FROM tenants WHERE team_id = $1`, [teamId]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(): Promise<TenantRecord[]> {
    const rows = await this.q(`SELECT ${SELECT} FROM tenants ORDER BY team_id`, []);
    return rows.map(toRecord);
  }

  async setStatus(teamId: string, status: TenantStatus): Promise<void> {
    await this.q(
      `UPDATE tenants SET status = $2, updated_at = now() WHERE team_id = $1`,
      [teamId, status],
    );
  }

  /** THE token read path — the per-workspace ears WebClient builder (decrypt + client, never logged). */
  async resolveBotTokenCiphertext(teamId: string): Promise<string | undefined> {
    const rows = (await this.repo.manager.query(
      `SELECT bot_token_ciphertext FROM tenants WHERE team_id = $1`,
      [teamId],
    )) as Array<{ bot_token_ciphertext: string }>;
    return rows[0]?.bot_token_ciphertext;
  }
}
