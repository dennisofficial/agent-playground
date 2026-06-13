import { CreateModule } from '@workspace/nestjs-core';
import { BotGraphModule } from '../bot-graph/bot-graph.module';
import { ChannelModule } from '../channel/channel.module';
import { EmployeesModule } from '../employees/employees.module';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';
import { MemoryModule } from '../memory/memory.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ConductorEventsModule } from './conductor-events.module';
import { ConductorMetricsService } from './conductor-metrics.service';
import { ConductorService } from './conductor.service';

/**
 * The event loop (ConductorService) + the presentation seam (ConductorEventsBus, via
 * ConductorEventsModule so tools can emit without a module cycle). The per-bot turn graphs live in
 * BotGraphModule — the conductor just dispatches turns onto them and relays their streamed deltas;
 * the graph's node-only dependencies (gate, recursion guard, tools, worktrees, llm) stay in
 * BotGraphModule, not here. UI-agnostic — surfaces subscribe to the bus.
 */
@CreateModule({
  imports: [
    BotGraphModule,
    ChannelModule,
    ConductorEventsModule,
    EmployeesModule,
    LlmKeysModule,
    MemoryModule,
    SessionsModule,
  ],
  services: [ConductorService, ConductorMetricsService],
  exports: [ConductorEventsModule, ConductorMetricsService],
})
export class ConductorModule {}
