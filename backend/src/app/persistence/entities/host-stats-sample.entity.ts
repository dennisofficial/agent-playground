import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { numberColumn } from './numeric.transformer';

/**
 * One host-global CPU/mem/disk/container sample, written by `HostStatsRecorderService` every ~15s and
 * pruned past 48h. Append-only time-series with no org/job FK (host-wide, not tenant-scoped) — standalone
 * rather than `TimestampedEntity` since `sampled_at` is the only timestamp a sample ever needs.
 */
@Entity({ name: 'host_stats_sample' })
@Index(['sampled_at'])
export class HostStatsSampleEntity {
  @PrimaryColumn({
    type: 'bigint',
    generated: 'identity',
    transformer: numberColumn,
  })
  id!: number;

  @Column({ type: 'timestamptz' })
  sampled_at!: Date;

  @Column({ type: 'real' })
  cpu_pct!: number;

  @Column({ type: 'real' })
  mem_pct!: number;

  @Column({ type: 'real' })
  disk_pct!: number;

  @Column({ type: 'int' })
  containers_running!: number;

  @Column({ type: 'int' })
  containers_total!: number;
}
