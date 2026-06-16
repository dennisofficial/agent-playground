// TypeORM entities (backend-only — imported via `@workspace/shared/schemas`, never the root barrel,
// so the web bundle never pulls TypeORM decorators).
export * from './admin-user.entity';
export * from './classes/base.entity';
export * from './bot-cursor.entity';
export * from './compaction-summary.entity';
export * from './channel-message.entity';
export * from './channel.entity';
export * from './employee-mcp-server.entity';
export * from './employee-skill.entity';
export * from './fact.entity';
export * from './github-token.entity';
export * from './metrics-event.entity';
export * from './pipeline-run.entity';
export * from './project.entity';
export * from './provider-key.entity';
export * from './session.entity';
export * from './session-event.entity';
export * from './session-note.entity';
export * from './task.entity';
export * from './team-setting.entity';
export * from './team-task-note.entity';
export * from './team-task-plan.entity';
export * from './team-task.entity';
export * from './tenant.entity';
export * from './worklog.entity';

import { AdminUser } from './admin-user.entity';
import { BotCursor } from './bot-cursor.entity';
import { ChannelMessage } from './channel-message.entity';
import { CompactionSummary } from './compaction-summary.entity';
import { Channel } from './channel.entity';
import { EmployeeMcpServer } from './employee-mcp-server.entity';
import { EmployeeSkill } from './employee-skill.entity';
import { Fact } from './fact.entity';
import { GithubToken } from './github-token.entity';
import { MetricsEvent } from './metrics-event.entity';
import { PipelineRun } from './pipeline-run.entity';
import { Project } from './project.entity';
import { ProviderKey } from './provider-key.entity';
import { Session } from './session.entity';
import { SessionEvent } from './session-event.entity';
import { SessionNote } from './session-note.entity';
import { Task } from './task.entity';
import { TeamSetting } from './team-setting.entity';
import { TeamTaskNote } from './team-task-note.entity';
import { TeamTaskPlan } from './team-task-plan.entity';
import { TeamTask } from './team-task.entity';
import { Tenant } from './tenant.entity';
import { Worklog } from './worklog.entity';

/** Every harness entity — pass to the TypeORM DataSource / `TypeOrmModule.forRoot({ entities })`.
 * Single DB: the `tenants` workspace registry lives here too (no separate control datasource). */
export const ENTITIES = [
  AdminUser,
  CompactionSummary,
  Fact,
  Task,
  TeamTask,
  TeamTaskPlan,
  TeamTaskNote,
  TeamSetting,
  Worklog,
  ChannelMessage,
  BotCursor,
  Channel,
  Project,
  GithubToken,
  MetricsEvent,
  PipelineRun,
  ProviderKey,
  Session,
  SessionEvent,
  SessionNote,
  Tenant,
  EmployeeSkill,
  EmployeeMcpServer,
];
