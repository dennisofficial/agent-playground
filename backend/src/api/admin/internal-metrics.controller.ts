import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  InternalMetricsQuery,
  InternalMetricsResponse,
} from '@workspace/shared';
import { MetricsEventsService } from '../../harness/metrics/metrics-events.service';
import { AdminTokenGuard } from './admin-token.guard';

@Controller('tenants/:teamId/internal-metrics')
@UseGuards(AdminTokenGuard)
export class InternalMetricsController {
  constructor(private readonly metrics: MetricsEventsService) {}

  @Get()
  summarize(
    @Param('teamId') teamId: string,
    @Query() query: InternalMetricsQuery,
  ): Promise<InternalMetricsResponse> {
    return this.metrics.summarizeByAgent({
      teamId,
      projectId: query.projectId,
      since: parseOptionalDate('since', query.since),
      until: parseOptionalDate('until', query.until),
    });
  }
}

function parseOptionalDate(name: string, value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${name} must be an ISO date string.`);
  }
  return parsed;
}
