import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { EmployeesModule } from '../employees/employees.module';
import { GateModule } from '../gate/gate.module';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { RecursionGuardModule } from '../recursion-guard/recursion-guard.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ToolsModule } from '../tools/tools.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { BotGraphFactory } from './bot-graph.factory';
import { ConductorEventsModule } from './conductor-events.module';
import { ConductorService } from './conductor.service';

/**
 * The orchestration core: per-bot turn graphs (BotGraphFactory), the event loop (ConductorService),
 * and the presentation seam (ConductorEventsBus, via ConductorEventsModule so tools can emit
 * without a module cycle). UI-agnostic — surfaces subscribe to the bus.
 */
@CreateModule({
  imports: [
    ChannelModule,
    ConductorEventsModule,
    EmployeesModule,
    GateModule,
    LlmKeysModule,
    LlmModule,
    MemoryModule,
    RecursionGuardModule,
    SessionsModule,
    ToolsModule,
    WorktreesModule,
  ],
  services: [BotGraphFactory, ConductorService],
  exports: [ConductorEventsModule],
})
export class ConductorModule {}
