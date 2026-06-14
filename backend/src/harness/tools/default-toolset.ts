import type { Type } from '@nestjs/common';
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
import {
  AddBoardTaskTool,
  ClaimBoardTaskTool,
  ListBoardTool,
  UpdateBoardTaskTool,
} from './tasks/board.tools';
import {
  AddTaskTool,
  CompleteTaskTool,
  ListTasksTool,
} from './tasks/task.tools';
import { AddNoteTool, GetTicketTool } from './tasks/ticket.tools';
import { SubmitPlanTool } from './sessions/submit-plan.tool';
import { SubmitForReviewTool } from './sessions/submit-for-review.tool';
import { InvestigateTool } from './sessions/investigate.tool';
import type { IHarnessTool } from './tool.types';
import { EndTurnTool } from './turn/end-turn.tool';
import {
  CreateWorktreeTool,
  ListWorktreesTool,
  PublishWorktreeTool,
  PullWorktreeTool,
  RefreshWorktreeTool,
  RemoveWorktreeTool,
} from './worktrees/worktree.tools';
import { RecentWorkTool } from './worklog/recent-work.tool';

/**
 * The shared chat toolset bound for an employee that doesn't override `tools`. Class references —
 * the ToolRegistry resolves them to bound LangChain tools at graph-build time.
 */
export const DEFAULT_CHAT_TOOLSET: ReadonlyArray<Type<IHarnessTool>> = [
  CreateWorktreeTool,
  ListWorktreesTool,
  PublishWorktreeTool,
  PullWorktreeTool,
  RefreshWorktreeTool,
  RemoveWorktreeTool,
  // No open_pr / mark_pr_ready for ICs — the review pipeline opens the draft PR and flips it to ready
  // automatically when self-review clears (submit_for_review kicks it off). Sam keeps them as a manual
  // lead override (see sam.employee.ts).
  CreateSessionTool,
  ReplySessionTool,
  SubmitPlanTool,
  SubmitForReviewTool,
  InvestigateTool,
  CloseSessionTool,
  CheckSessionTool,
  ListSessionsTool,
  SearchSessionTool,
  RecentWorkTool,
  EndTurnTool,
  RememberTool,
  RecallTool,
  UpdateMemoryTool,
  ForgetTool,
  SearchConversationHistoryTool,
  AddSessionNoteTool,
  ListSessionNotesTool,
  ResolveSessionNoteTool,
  ListTasksTool,
  AddTaskTool,
  CompleteTaskTool,
  ListBoardTool,
  AddBoardTaskTool,
  ClaimBoardTaskTool,
  UpdateBoardTaskTool,
  GetTicketTool,
  AddNoteTool,
  ListRoomsTool,
  SendMessageTool,
  ShareArtifactTool,
];
