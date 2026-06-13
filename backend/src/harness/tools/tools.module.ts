import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { ConductorEventsModule } from '../conductor/conductor-events.module';
import { EmployeesModule } from '../employees/employees.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WorktreesModule } from '../worktrees/worktrees.module';
import { ShareArtifactTool } from './artifacts/share-artifact.tool';
import {
  ForgetTool,
  RecallTool,
  RememberTool,
  UpdateMemoryTool,
} from './memory/memory.tools';
import { ListRoomsTool, SendMessageTool } from './rooms/room.tools';
import {
  CheckSessionTool,
  CloseSessionTool,
  CreateSessionTool,
  ListSessionsTool,
  ReplySessionTool,
  SearchSessionTool,
} from './sessions/session.tools';
import {
  AddBoardTaskTool,
  ClaimBoardTaskTool,
  ListBoardTool,
  UpdateBoardTaskTool,
} from './tasks/board.tools';
import { ApprovePlanTool, ProposePlanTool } from './tasks/proposal.tools';
import { CloseStandupTool, OpenStandupTool } from './tasks/standup.tools';
import {
  AddTaskTool,
  CompleteTaskTool,
  ListTasksTool,
} from './tasks/task.tools';
import { AddNoteTool, GetTicketTool } from './tasks/ticket.tools';
import { ToolRegistry } from './tool.registry';
import { EndTurnTool } from './turn/end-turn.tool';
import {
  CreateWorktreeTool,
  ListWorktreesTool,
  PublishWorktreeTool,
  PullWorktreeTool,
  RemoveWorktreeTool,
} from './worktrees/worktree.tools';
import { ListPullRequestsTool } from './projects/list-pull-requests.tool';
import { OpenPrTool } from './worktrees/open-pr.tool';
import { MarkPrReadyTool } from './worktrees/mark-pr-ready.tool';
import { RecentWorkTool } from './worklog/recent-work.tool';

/**
 * The chat-layer tool surface. Every `@HarnessTool()` class is registered here as a PLAIN CLASS
 * provider (discovery cannot see factory providers) and exported so employee definitions can
 * reference the class as their allowlist token.
 */
@CreateModule({
  imports: [
    DiscoveryModule,
    ChannelModule,
    ConductorEventsModule,
    EmployeesModule,
    MemoryModule,
    ProjectsModule,
    SessionsModule,
    WorktreesModule,
  ],
  services: [
    ToolRegistry,
    // rooms (cross-room relay)
    ListRoomsTool,
    SendMessageTool,
    // worktrees
    CreateWorktreeTool,
    ListWorktreesTool,
    PublishWorktreeTool,
    PullWorktreeTool,
    RemoveWorktreeTool,
    OpenPrTool,
    MarkPrReadyTool,
    // projects
    ListPullRequestsTool,
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
    // team board
    ListBoardTool,
    AddBoardTaskTool,
    ClaimBoardTaskTool,
    UpdateBoardTaskTool,
    // tickets (plans + notes)
    GetTicketTool,
    AddNoteTool,
    // approval pipeline + standup (lead-only, Sam's roster array)
    ApprovePlanTool,
    ProposePlanTool,
    OpenStandupTool,
    CloseStandupTool,
    // artifacts
    ShareArtifactTool,
  ],
})
export class ToolsModule {}
