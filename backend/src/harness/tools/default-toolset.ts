import type { Type } from '@nestjs/common';
import { CancelJobTool, CheckJobTool, ContinueWorkTool, DispatchJobTool, EndTurnTool, RecentWorkTool } from './jobs/job.tools';
import { ForgetTool, RecallTool, RememberTool, UpdateMemoryTool } from './memory/memory.tools';
import { AddTaskTool, CompleteTaskTool, ListTasksTool } from './tasks/task.tools';
import type { IHarnessTool } from './tool.types';

/**
 * The shared chat toolset bound for an employee that doesn't override `tools`. Mirrors the
 * playground's CHAT_TOOLS (minus the board tools, which are not in this pass). Class references —
 * the ToolRegistry resolves them to bound LangChain tools at graph-build time.
 */
export const DEFAULT_CHAT_TOOLSET: ReadonlyArray<Type<IHarnessTool>> = [
  DispatchJobTool,
  ContinueWorkTool,
  CheckJobTool,
  CancelJobTool,
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
