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
import {
  CreateWorktreeTool,
  ListWorktreesTool,
  PublishWorktreeTool,
  PullWorktreeTool,
  RefreshWorktreeTool,
  RemoveWorktreeTool,
} from './worktrees/worktree.tools';
import { MarkPrReadyTool } from './worktrees/mark-pr-ready.tool';
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
  // The review pipeline opens the draft PR + runs the self-review, but no longer flips the PR to ready
  // itself (a stateless adversarial verdict looped forever — the #49 bug). It hands the ship-or-fix
  // call to the owner, so ICs carry mark_pr_ready (their "it's your turn, Dennis" gesture).
  // open_pr stays a lead-only manual override.
  MarkPrReadyTool,
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
