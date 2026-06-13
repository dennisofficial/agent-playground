import { TeamSetting as TeamSettingEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows } from './sql';

/**
 * Per-team durable settings (harness-owned — see team-setting.entity.ts for why this is not on
 * `tenants`). Currently the standup flag: while open, the execute gate refuses every flip —
 * approval at the sitting doesn't mean GO until the lead closes the standup.
 */
export class TeamSettingsStore {
  constructor(private readonly repo: Repository<TeamSettingEntity>) {}

  async isStandupOpen(team: string): Promise<boolean> {
    const rows = rawRows<{ standup_open: boolean }>(
      await this.repo.manager.query(
        `SELECT standup_open FROM team_settings WHERE team_id = $1`,
        [team],
      ),
    );
    return rows[0]?.standup_open === true; // missing row = no standup ever opened = closed
  }

  async setStandupOpen(team: string, open: boolean): Promise<void> {
    await this.repo.manager.query(
      `INSERT INTO team_settings (team_id, standup_open, created_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (team_id) DO UPDATE SET standup_open = $2, updated_at = now()`,
      [team, open],
    );
  }
}
