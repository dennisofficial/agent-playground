import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { MetricsEvent } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { MetricsEventsService } from './metrics-events.service';

@CreateModule({
  imports: [TypeOrmModule.forFeature([MetricsEvent])],
  services: [
    {
      provide: MetricsEventsService,
      inject: [getRepositoryToken(MetricsEvent)],
      useFactory: (events: Repository<MetricsEvent>) =>
        new MetricsEventsService(events),
    },
  ],
})
export class MetricsModule {}
