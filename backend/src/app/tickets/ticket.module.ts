import { Global, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
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
 * (Step 3 tools) can inject `TicketService` and the web surface can inject `TicketEventBus` for the
 * SSE merge WITHOUT import edges — keeping `BrainModule`/`SurfaceModule` free of a cycle with this
 * module. Registered in `FeaturesModule`; the three entities are also in the persistence `ENTITIES`.
 *
 * On boot it reconciles STRANDED tickets — any ticket parked in a thread-driven lane whose linked thread
 * is gone (a deleted thread that slipped past the inline revert, a crash mid-delete) — back to `todo`, so
 * the board can never permanently strand a ticket the operator can't move by hand.
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
export class TicketsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(TicketsModule.name);

  constructor(private readonly tickets: TicketService) {}

  /** Fail-soft boot backstop — a reconcile hiccup must never block application startup. */
  async onApplicationBootstrap(): Promise<void> {
    await this.tickets.reconcileStrandedTickets().catch((err) => {
      this.logger.warn(`stranded-ticket reconcile failed: ${err}`);
    });
  }
}
