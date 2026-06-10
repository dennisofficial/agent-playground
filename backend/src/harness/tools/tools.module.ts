import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { MemoryModule } from '../memory/memory.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import {
  ForgetTool,
  RecallTool,
  RememberTool,
  UpdateMemoryTool,
} from './memory/memory.tools';
import {
  CheckSessionTool,
  CloseSessionTool,
  CreateSessionTool,
  ListSessionsTool,
  ReplySessionTool,
  SearchSessionTool,
} from './sessions/session.tools';
import {
  AddTaskTool,
  CompleteTaskTool,
  ListTasksTool,
} from './tasks/task.tools';
import { ToolRegistry } from './tool.registry';
import { EndTurnTool } from './turn/end-turn.tool';
import {
  CreateWorktreeTool,
  ListWorktreesTool,
  RemoveWorktreeTool,
} from './worktrees/worktree.tools';
import { RecentWorkTool } from './worklog/recent-work.tool';

/**
 * The chat-layer tool surface. Every `@HarnessTool()` class is registered here as a PLAIN CLASS
 * provider (discovery cannot see factory providers) and exported so employee definitions can
 * reference the class as their allowlist token.
 */
@CreateModule({
  imports: [
    DiscoveryModule,
    EmployeesModule,
    MemoryModule,
    SessionsModule,
    WorktreesModule,
  ],
  services: [
    ToolRegistry,
    // worktrees
    CreateWorktreeTool,
    ListWorktreesTool,
    RemoveWorktreeTool,
    // sessions
    CreateSessionTool,
    ReplySessionTool,
    CloseSessionTool,
    CheckSessionTool,
    ListSessionsTool,
    SearchSessionTool,
    // worklog + turn
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
