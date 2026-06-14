import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Per-team durable settings — harness-owned (deliberately NOT on `tenants`: that table is the
 * slack-app's OAuth registry, and the TUI's 'local' team has no row there). One row per team,
 * created on first write. Currently just the standup flag: while a standup is open, the execute
 * gate refuses every flip — approval at the sitting doesn't mean GO until the lead closes it.
 */
@Entity({ name: 'team_settings' })
export class TeamSetting extends TimestampedEntity {
  /** The team (tenant) id — 'local' for the TUI/dev team. */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  @Column({ type: 'boolean', default: false })
  standup_open!: boolean;
}
