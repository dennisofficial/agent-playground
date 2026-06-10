import type { Type } from '@nestjs/common';
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
import type { IHarnessTool } from './tool.types';
import { EndTurnTool } from './turn/end-turn.tool';
import {
  CreateWorktreeTool,
  ListWorktreesTool,
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
  RemoveWorktreeTool,
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
  ListTasksTool,
  AddTaskTool,
  CompleteTaskTool,
];
