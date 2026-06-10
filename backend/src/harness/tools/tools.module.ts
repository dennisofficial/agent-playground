import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { JobsModule } from '../jobs/jobs.module';
import { MemoryModule } from '../memory/memory.module';
import { CancelJobTool, CheckJobTool, ContinueWorkTool, DispatchJobTool, EndTurnTool, RecentWorkTool } from './jobs/job.tools';
import { ForgetTool, RecallTool, RememberTool, UpdateMemoryTool } from './memory/memory.tools';
import { AddTaskTool, CompleteTaskTool, ListTasksTool } from './tasks/task.tools';
import { ToolRegistry } from './tool.registry';

/**
 * The chat-layer tool surface. Every `@HarnessTool()` class is registered here as a PLAIN CLASS
 * provider (discovery cannot see factory providers) and exported so employee definitions can
 * reference the class as their allowlist token.
 */
@CreateModule({
  imports: [DiscoveryModule, EmployeesModule, MemoryModule, JobsModule],
  services: [
    ToolRegistry,
    // jobs
    DispatchJobTool,
    ContinueWorkTool,
    CheckJobTool,
    CancelJobTool,
    RecentWorkTool,
    EndTurnTool,
    // memory
    RememberTool,
    RecallTool,
    UpdateMemoryTool,
    ForgetTool,
    // reminders
    ListTasksTool,
    AddTaskTool,
    CompleteTaskTool,
  ],
})
export class ToolsModule {}
