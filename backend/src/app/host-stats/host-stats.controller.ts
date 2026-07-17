import type { MessageEvent } from '@nestjs/common';
import { Controller, Get, Query, Sse } from '@nestjs/common';
import { catchError, EMPTY, from, interval, map, Observable, startWith, switchMap } from 'rxjs';
import { HostStatsSampleRepository } from './host-stats-sample.repository';
import { HostStatsService } from './host-stats.service';
import type { HostStatsDto, HostStatsHistoryPoint } from './host-stats.types';

/** Realtime SSE push cadence. */
const REALTIME_MS = 3_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseHistoryHours(raw: string | undefined): number {
  if (raw === undefined) return 24;
  const value = Number(raw);
  return clamp(Number.isFinite(value) ? value : 24, 1, 48);
}

/**
 * Login-gated (no `@Public()`, no org guard) live host snapshot for the ops dashboard.
 */
@Controller('web/host-stats')
export class HostStatsController {
  constructor(
    private readonly stats: HostStatsService,
    private readonly samples: HostStatsSampleRepository,
  ) {}

  @Get()
  get(): Promise<HostStatsDto> {
    return this.stats.collect();
  }

  @Sse('realtime')
  realtime(): Observable<MessageEvent> {
    return interval(REALTIME_MS).pipe(
      startWith(0),
      // Swallow a transient collect() failure (e.g. statfs() rejecting) so one bad tick
      // skips instead of erroring the stream and triggering an EventSource reconnect-storm.
      switchMap(() => from(this.stats.collect()).pipe(catchError(() => EMPTY))),
      map((snap) => ({ data: snap })),
    );
  }

  @Get('history')
  history(@Query('hours') hoursRaw?: string): Promise<{ points: HostStatsHistoryPoint[] }> {
    const hours = parseHistoryHours(hoursRaw);
    return this.samples.history(hours).then((points) => ({ points }));
  }
}
