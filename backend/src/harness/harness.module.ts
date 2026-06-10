import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from './channel/channel.module';
import { ConductorModule } from './conductor/conductor.module';
import { EmployeesModule } from './employees/employees.module';
import { EnginesModule } from './engines/engines.module';
import { GateModule } from './gate/gate.module';
import { JobsModule } from './jobs/jobs.module';
import { LlmModule } from './llm/llm.module';
import { MemoryModule } from './memory/memory.module';
import { SkillsModule } from './skills/skills.module';
import { SurfaceModule } from './surface/surface.module';
import { ToolsModule } from './tools/tools.module';

/**
 * The harness composition root: one import for any app that hosts the AI-employee harness.
 * Domain modules land here as the migration progresses (channel, employees, tools, engines,
 * gate, jobs, conductor, surface, skills). The `modules:` bucket re-exports each one, so a
 * hosting app (the tui today; the api once the Slack adapter lands) imports only this module.
 *
 * Only ONE process may compose this module at a time — the conductor assumes it is the sole
 * writer over the channel/cursor tables (no multi-conductor locking story yet).
 *
 * Requires `DatabaseModule` and `EsmModule` (both @Global) in the hosting app.
 */
@CreateModule({
  modules: [
    ChannelModule,
    MemoryModule,
    EmployeesModule,
    ToolsModule,
    SkillsModule,
    GateModule,
    LlmModule,
    EnginesModule,
    JobsModule,
    ConductorModule,
    SurfaceModule,
  ],
})
export class HarnessModule {}
