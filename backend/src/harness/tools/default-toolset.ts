import type { Type } from '@nestjs/common';
import {
  ForgetTool,
  RecallTool,
  RememberTool,
  SearchConversationHistoryTool,
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
import {
  AddTaskTool,
  CompleteTaskTool,
  ListTasksTool,
} from './tasks/task.tools';
import { AddNoteTool, GetTicketTool } from './tasks/ticket.tools';
import type { IHarnessTool } from './tool.types';
import { EndTurnTool } from './turn/end-turn.tool';
import {
  CreateWorktreeTool,
  ListWorktreesTool,
  PublishWorktreeTool,
  PullWorktreeTool,
  RemoveWorktreeTool,
} from './worktrees/worktree.tools';
import { OpenPrTool } from './worktrees/open-pr.tool';
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
  RemoveWorktreeTool,
  OpenPrTool,
  CreateSessionTool,
  ReplySessionTool,
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
];
