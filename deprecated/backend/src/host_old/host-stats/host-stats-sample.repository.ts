import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { HostStatsSampleEntity } from '../persistence/entities';
import type { HostStatsDto, HostStatsHistoryPoint } from './host-stats.types';

const HISTORY_BUCKETS = 288;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

type HistoryRow = {
  bucket_epoch: string;
  cpu: string;
  mem: string;
  disk: string;
  run: string;
  total: string;
};

@Injectable()
export class HostStatsSampleRepository {
  constructor(
    @InjectRepository(HostStatsSampleEntity, DB_CONNECTION)
    private readonly repo: Repository<HostStatsSampleEntity>,
  ) {}

  async insertSnapshot(snap: HostStatsDto): Promise<void> {
    await this.repo.insert({
      sampled_at: new Date(snap.sampledAt),
      cpu_pct: snap.cpu.usagePct,
      mem_pct: snap.memory.usagePct,
      disk_pct: snap.disk.usagePct,
      containers_running: snap.containers.running,
      containers_total: snap.containers.total,
    });
  }

  async history(hours: number): Promise<HostStatsHistoryPoint[]> {
    const bucketSec = Math.round((hours * 3600) / HISTORY_BUCKETS);
    const rows: HistoryRow[] = await this.repo.query(
      `SELECT floor(extract(epoch from sampled_at) / $1) * $1 AS bucket_epoch,
              avg(cpu_pct)  AS cpu,
              avg(mem_pct)  AS mem,
              avg(disk_pct) AS disk,
              avg(containers_running) AS run,
              max(containers_total)   AS total
       FROM host_stats_sample
       WHERE sampled_at >= now() - ($2 || ' hours')::interval
       GROUP BY bucket_epoch
       ORDER BY bucket_epoch`,
      [bucketSec, hours],
    );
    return rows.map((row) => ({
      t: new Date(Number(row.bucket_epoch) * 1000).toISOString(),
      cpuPct: round1(Number(row.cpu)),
      memPct: round1(Number(row.mem)),
      diskPct: round1(Number(row.disk)),
      containersRunning: Math.round(Number(row.run)),
      containersTotal: Number(row.total),
    }));
  }

  async pruneOlderThan(hours: number): Promise<void> {
    await this.repo.query(
      `DELETE FROM host_stats_sample WHERE sampled_at < now() - ($1 || ' hours')::interval`,
      [hours],
    );
  }
}
