import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { EmployeesModule } from '../employees/employees.module';
import { GateModule } from '../gate/gate.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ToolsModule } from '../tools/tools.module';
import { BotGraphFactory } from './bot-graph.factory';
import { ConductorEventsBus } from './conductor-events.bus';
import { ConductorService } from './conductor.service';

/**
 * The orchestration core: per-bot turn graphs (BotGraphFactory), the event loop (ConductorService),
 * and the presentation seam (ConductorEventsBus). UI-agnostic — surfaces subscribe to the bus.
 */
@CreateModule({
  imports: [
    ChannelModule,
    EmployeesModule,
    GateModule,
    LlmModule,
    MemoryModule,
    SessionsModule,
    ToolsModule,
  ],
  services: [ConductorEventsBus, BotGraphFactory, ConductorService],
})
export class ConductorModule {}
