import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Tenant } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';

export type TenantStatus = 'provisioning' | 'active' | 'suspended';

export interface TenantRecord {
  teamId: string;
  teamName: string;
  status: TenantStatus;
  stackBaseUrl: string | null;
  installedBy: string | null;
}

interface TenantRow {
  team_id: string;
  team_name: string;
  status: TenantStatus;
  stack_base_url: string | null;
  installed_by: string | null;
}

const toRecord = (r: TenantRow): TenantRecord => ({
  teamId: r.team_id,
  teamName: r.team_name,
  status: r.status,
  stackBaseUrl: r.stack_base_url,
  installedBy: r.installed_by,
});

const SELECT = `team_id, team_name, status, stack_base_url, installed_by`;

/**
 * The tenant registry (control DB, raw-SQL house style). Bot tokens are WRITE-ONLY here: every
 * read path returns routing metadata, never ciphertext; `resolveBotTokenCiphertext()` exists for
 * the provision seam alone, which decrypts via SecretCipher and hands the plaintext straight into
 * the env overlay — never into logs or responses.
 */
@Injectable()
export class TenantStore {
  constructor(
    @InjectRepository(Tenant) private readonly repo: Repository<Tenant>,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<TenantRow[]> {
    return (await this.repo.manager.query(sql, params)) as TenantRow[];
  }

  /** Install/reinstall: insert or refresh name + token ciphertext + installer. A reinstall keeps
   * routing state (status/stack) — the stack just holds a stale token until restarted. */
  async upsertFromOauth(input: {
    teamId: string;
    teamName: string;
    botTokenCiphertext: string;
    installedBy?: string;
  }): Promise<TenantRecord> {
    const rows = await this.q(
      `INSERT INTO tenants (team_id, team_name, status, bot_token_ciphertext, installed_by)
       VALUES ($1, $2, 'provisioning', $3, $4)
       ON CONFLICT (team_id) DO UPDATE SET
         team_name = EXCLUDED.team_name,
         bot_token_ciphertext = EXCLUDED.bot_token_ciphertext,
         installed_by = EXCLUDED.installed_by,
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
      `UPDATE tenants SET status = $2, updated_at = now() WHERE team_id = $1 RETURNING ${SELECT}`,
      [teamId, status],
    );
  }

  /** Provisioned: where the gateway forwards this workspace's events. Also activates routing. */
  async setStack(teamId: string, stackBaseUrl: string): Promise<void> {
    await this.q(
      `UPDATE tenants SET stack_base_url = $2, status = 'active', updated_at = now()
       WHERE team_id = $1 RETURNING ${SELECT}`,
      [teamId, stackBaseUrl],
    );
  }

  /** THE token read path — provision seam only (decrypt + env overlay, never logged). */
  async resolveBotTokenCiphertext(teamId: string): Promise<string | undefined> {
    const rows = (await this.repo.manager.query(
      `SELECT bot_token_ciphertext FROM tenants WHERE team_id = $1`,
      [teamId],
    )) as Array<{ bot_token_ciphertext: string }>;
    return rows[0]?.bot_token_ciphertext;
  }
}
