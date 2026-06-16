import { CreateModule } from '@workspace/nestjs-core';
import { ScheduleModule } from '@nestjs/schedule';
import { ChannelModule } from './channel/channel.module';
import { ConductorModule } from './conductor/conductor.module';
import { EmployeesModule } from './employees/employees.module';
import { EnginesModule } from './engines/engines.module';
import { GateModule } from './gate/gate.module';
import { CredentialModule } from './llm-keys/credential.module';
import { LlmModule } from './llm/llm.module';
import { MemoryModule } from './memory/memory.module';
import { ObservabilityModule } from './observability/observability.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { SessionsModule } from './sessions/sessions.module';
import { SkillsModule } from './skills/skills.module';
import { SurfaceModule } from './surface/surface.module';
import { ToolsModule } from './tools/tools.module';
import { WorktreesModule } from './worktrees/worktrees.module';

/**
 * The harness composition root: one import for any app that hosts the AI-employee harness.
 * Domain modules land here as the migration progresses (channel, employees, tools, engines,
 * gate, worktrees, sessions, conductor, surface, skills). The `modules:` bucket re-exports each
 * one, so a hosting app (the tui today; the api once the Slack adapter lands) imports only this
 * module.
 *
 * Only ONE process may compose this module at a time — the conductor is the sole writer over the
 * channel/cursor tables (no multi-conductor locking story yet). It serves ALL tenants (Slack
 * workspaces) from that one process: rooms/cursors/memory carry a tenant dimension and keys flow
 * per-turn via the @Global CredentialModule.
 *
 * `ScheduleModule.forRoot()` is imported here — the single composition root — so the Phase 7
 * `MemoryConsolidationService` cron job runs in exactly one process. Never import
 * `ScheduleModule.forRoot()` in a sub-module or a secondary app.
 *
 * Requires `DatabaseModule` and `EsmModule` (both @Global) in the hosting app.
 */
@CreateModule({
  // ScheduleModule.forRoot() lives here so only the harness (single process) owns the scheduler.
  imports: [ScheduleModule.forRoot()],
  modules: [
    CredentialModule,
    ObservabilityModule,
    ChannelModule,
    MemoryModule,
    EmployeesModule,
    ToolsModule,
    SkillsModule,
    GateModule,
    LlmModule,
    EnginesModule,
    WorktreesModule,
    PipelinesModule,
    SessionsModule,
    ConductorModule,
    SurfaceModule,
  ],
})
export class HarnessModule {}
