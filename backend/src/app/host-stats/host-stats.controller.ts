import { Controller, Get } from '@nestjs/common';
import { HostStatsService } from './host-stats.service';
import type { HostStatsDto } from './host-stats.types';

/**
 * Login-gated (no `@Public()`, no org guard) live host snapshot for the ops dashboard.
 */
@Controller('web/host-stats')
export class HostStatsController {
  constructor(private readonly stats: HostStatsService) {}

  @Get()
  get(): Promise<HostStatsDto> {
    return this.stats.collect();
  }
}
