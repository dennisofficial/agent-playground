import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { ProjectOnboardModule } from '../approvals/project-onboard.module';
import { ProposalModule } from '../approvals/proposal.module';
import { SuggestionModule } from '../approvals/suggestion.module';
import { ChannelModule } from '../channel/channel.module';
import { ConductorEventsModule } from '../conductor/conductor-events.module';
import { EmployeesModule } from '../employees/employees.module';
import { MemoryModule } from '../memory/memory.module';
import { ProjectsModule } from '../projects/projects.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ShareArtifactTool } from './artifacts/share-artifact.tool';
import {
  ForgetTool,
  RecallTool,
  RememberTool,
  SearchConversationHistoryTool,
  UpdateMemoryTool,
} from './memory/memory.tools';
import {
  AddSessionNoteTool,
  ListSessionNotesTool,
  ResolveSessionNoteTool,
} from './memory/session-note.tools';
import { ListRoomsTool, SendMessageTool } from './rooms/room.tools';
import {
  CheckSessionTool,
  CloseSessionTool,
  CreateSessionTool,
  ListSessionsTool,
  ReplySessionTool,
  SearchSessionTool,
} from './sessions/session.tools';
import { SubmitPlanTool } from './sessions/submit-plan.tool';
import { SubmitForReviewTool } from './sessions/submit-for-review.tool';
import { InvestigateTool } from './sessions/investigate.tool';
import { EngineToolFactory } from './engine-tool.factory';
import {
  AddBoardTaskTool,
  ClaimBoardTaskTool,
  ListBoardTool,
  UpdateBoardTaskTool,
} from './tasks/board.tools';
import { ApprovePlanTool, ProposePlanTool } from './tasks/proposal.tools';
import { SuggestTaskTool } from './tasks/suggest-task.tool';
import { CloseStandupTool, OpenStandupTool } from './tasks/standup.tools';
import {
  AddTaskTool,
  CompleteTaskTool,
  ListTasksTool,
} from './tasks/task.tools';
import { AddNoteTool, GetTicketTool } from './tasks/ticket.tools';
import { ToolRegistry } from './tool.registry';
import {
  CreateWorkspaceTool,
  ListWorkspacesTool,
  PublishWorkspaceTool,
  PullWorkspaceTool,
  RefreshWorkspaceTool,
  RemoveWorkspaceTool,
} from './workspaces/workspace.tools';
import { ListPullRequestsTool } from './projects/list-pull-requests.tool';
import { OnboardProjectTool } from './projects/onboard-project.tool';
import {
  ListReferenceProjectsTool,
  ReferenceProjectTool,
  ReferenceRepoTool,
} from './references/reference.tools';
import { OpenPrTool } from './workspaces/open-pr.tool';
import { MarkPrReadyTool } from './workspaces/mark-pr-ready.tool';
import { RecentWorkTool } from './worklog/recent-work.tool';
import {
  AnswerSectionTool,
  AttachDesignTool,
  CheckPipelineTool,
  DispatchFixupSessionTool,
  DispatchPipelineTool,
  EnqueueFindingTool,
  InsertSectionTool,
  ReopenSectionTool,
  ReorderSectionsTool,
  SkipDesignTool,
} from './pipelines/pipeline.tools';

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
    ProjectOnboardModule,
    ProposalModule,
    SuggestionModule,
    SessionsModule,
    WorkspacesModule,
  ],
  services: [
    ToolRegistry,
    // capability tool seam (binds tool-triggered capabilities at graph-build)
    EngineToolFactory,
    // rooms (cross-room relay)
    ListRoomsTool,
    SendMessageTool,
    // workspaces
    CreateWorkspaceTool,
    ListWorkspacesTool,
    PublishWorkspaceTool,
    PullWorkspaceTool,
    RefreshWorkspaceTool,
    RemoveWorkspaceTool,
    OpenPrTool,
    MarkPrReadyTool,
    // projects
    ListPullRequestsTool,
    // reference projects (read-only cross-project grounding) + self-onboarding
    ReferenceProjectTool,
    ReferenceRepoTool,
    ListReferenceProjectsTool,
    OnboardProjectTool,
    // sessions
    CreateSessionTool,
    ReplySessionTool,
    SubmitPlanTool,
    SubmitForReviewTool,
    InvestigateTool,
    CloseSessionTool,
    CheckSessionTool,
    ListSessionsTool,
    SearchSessionTool,
    // worklog
    RecentWorkTool,
    // memory
    RememberTool,
    RecallTool,
    UpdateMemoryTool,
    ForgetTool,
    SearchConversationHistoryTool,
    // session notes (thread-local scratchpad)
    AddSessionNoteTool,
    ListSessionNotesTool,
    ResolveSessionNoteTool,
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
    // approval pipeline + standup (lead-only)
    ApprovePlanTool,
    ProposePlanTool,
    OpenStandupTool,
    CloseStandupTool,
    // task-suggestion chip (lead-only proactive work proposal)
    SuggestTaskTool,
    // artifacts
    ShareArtifactTool,
    // pipelines (orchestrator dispatch + backlog enqueue + design gate + living sections + review decisions)
    DispatchPipelineTool,
    EnqueueFindingTool,
    AttachDesignTool,
    SkipDesignTool,
    AnswerSectionTool,
    InsertSectionTool,
    ReorderSectionsTool,
    DispatchFixupSessionTool,
    ReopenSectionTool,
    CheckPipelineTool,
  ],
})
export class ToolsModule {}
