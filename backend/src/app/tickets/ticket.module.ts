import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  RepoEntity,
  ThreadEntity,
  TicketCounterEntity,
  TicketDependencyEntity,
  TicketEntity,
} from '../persistence/entities';
import { TicketController } from './ticket.controller';
import { TicketEventBus } from './ticket-event-bus';
import { TicketService } from './ticket.service';

/**
 * TICKETS — the internal board/backlog. `@Global` (like `OrgModule`/`OnboardingModule`) so the brain
 * (Phase 3 tools) can inject `TicketService` and the web surface can inject `TicketEventBus` for the
 * SSE merge WITHOUT import edges — keeping `BrainModule`/`SurfaceModule` free of a cycle with this
 * module. Registered in `FeaturesModule`; the three entities are also in the persistence `ENTITIES`.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [
        TicketEntity,
        TicketDependencyEntity,
        TicketCounterEntity,
        ThreadEntity,
        DecisionRecordEntity,
        RepoEntity,
      ],
      DB_CONNECTION,
    ),
  ],
  controllers: [TicketController],
  providers: [TicketService, TicketEventBus],
  exports: [TicketService, TicketEventBus],
})
export class TicketsModule {}
