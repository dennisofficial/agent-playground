import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { numberColumn } from './numeric.transformer';

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
