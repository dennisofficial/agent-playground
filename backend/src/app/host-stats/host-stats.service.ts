import { Inject, Injectable, Logger } from '@nestjs/common';
import { statfsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CONTAINER_ENGINE, type ContainerEngine } from '../sandbox/container-engine.port';
import type { HostStatsDto } from './host-stats.types';

const CACHE_MS = 2_000;
const FIRST_SAMPLE_DELAY_MS = 200;

const SANDBOX_LABEL = 'atlas.managed=1';

type CpuAggregate = {
  idle: number;
  total: number;
};

@Injectable()
export class HostStatsService {
  private readonly logger = new Logger(HostStatsService.name);
  private readonly diskPath: string;
  private cached?: { at: number; value: HostStatsDto };
  private inflight?: Promise<HostStatsDto>;
  private prevCpu?: CpuAggregate;

  constructor(@Inject(CONTAINER_ENGINE) private readonly engine: ContainerEngine) {
    const candidate = process.env.HOST_STATS_DISK_PATH ?? '/srv/atlas/data';
    try {
      statfsSync(candidate);
      this.diskPath = candidate;
    } catch {
      this.diskPath = '/';
    }
  }

  async collect(): Promise<HostStatsDto> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }

    this.inflight ??= this.collectFresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async collectFresh(): Promise<HostStatsDto> {
    const [cpu, disk, containers, dockerDisk] = await Promise.all([
      this.sampleCpu(),
      this.sampleDisk(),
      this.sampleContainers(),
      this.sampleDockerDisk(),
    ]);
    const memory = this.sampleMemory();
    const host = this.sampleHost();

    const value: HostStatsDto = {
      cpu,
      memory,
      disk,
      host,
      containers,
      dockerDisk,
      sampledAt: new Date().toISOString(),
    };
    this.cached = { at: Date.now(), value };
    return value;
  }

  private async sampleCpu(): Promise<HostStatsDto['cpu']> {
    let prev = this.prevCpu;
    if (!prev) {
      prev = aggregateCpuTimes();
      await delay(FIRST_SAMPLE_DELAY_MS);
    }
    const next = aggregateCpuTimes();
    const deltaTotal = next.total - prev.total;
    const deltaIdle = next.idle - prev.idle;
    const usagePct = deltaTotal > 0 ? Math.round(100 * (1 - deltaIdle / deltaTotal)) : 0;
    this.prevCpu = next;
    return {
      usagePct,
      cores: os.cpus().length,
      loadAvg: os.loadavg() as [number, number, number],
    };
  }

  private sampleMemory(): HostStatsDto['memory'] {
    const totalBytes = os.totalmem();
    const usedBytes = totalBytes - os.freemem();
    return {
      usedBytes,
      totalBytes,
      usagePct: Math.round((100 * usedBytes) / totalBytes),
    };
  }

  private async sampleDisk(): Promise<HostStatsDto['disk']> {
    const s = await statfs(this.diskPath);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bfree * s.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      usedBytes,
      totalBytes,
      usagePct: Math.round(100 * (1 - s.bfree / s.blocks)),
      path: this.diskPath,
    };
  }

  private sampleHost(): HostStatsDto['host'] {
    return { uptimeSeconds: os.uptime() };
  }

  private async sampleContainers(): Promise<HostStatsDto['containers']> {
    try {
      const all = await this.engine.list({ all: true, label: SANDBOX_LABEL });
      return {
        total: all.length,
        running: all.filter((c) => c.state === 'running').length,
      };
    } catch (err) {
      this.logger.warn(`failed to list containers: ${String(err)}`);
      return { running: 0, total: 0 };
    }
  }

  private async sampleDockerDisk(): Promise<HostStatsDto['dockerDisk']> {
    if (!this.engine.systemDf) return null;
    try {
      const df = await this.engine.systemDf();
      return { usedBytes: df.totalBytes };
    } catch (err) {
      this.logger.warn(`failed to read Docker disk usage: ${String(err)}`);
      return null;
    }
  }
}

function aggregateCpuTimes(): CpuAggregate {
  return os.cpus().reduce<CpuAggregate>(
    (acc, cpu) => {
      const { user, nice, sys, idle, irq } = cpu.times;
      return {
        idle: acc.idle + idle,
        total: acc.total + user + nice + sys + idle + irq,
      };
    },
    { idle: 0, total: 0 },
  );
}
