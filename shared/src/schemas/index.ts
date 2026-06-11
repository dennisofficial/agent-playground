// TypeORM entities (backend-only — imported via `@workspace/shared/schemas`, never the root barrel,
// so the web bundle never pulls TypeORM decorators).
export * from './classes/base.entity';
export * from './bot-cursor.entity';
export * from './channel-message.entity';
export * from './channel.entity';
export * from './employee-skill.entity';
export * from './fact.entity';
export * from './github-token.entity';
export * from './project.entity';
export * from './provider-key.entity';
export * from './slack-identity.entity';
export * from './task.entity';
export * from './team-task.entity';
export * from './tenant.entity';
export * from './worklog.entity';

import { BotCursor } from './bot-cursor.entity';
import { ChannelMessage } from './channel-message.entity';
import { Channel } from './channel.entity';
import { EmployeeSkill } from './employee-skill.entity';
import { Fact } from './fact.entity';
import { GithubToken } from './github-token.entity';
import { Project } from './project.entity';
import { ProviderKey } from './provider-key.entity';
import { SlackIdentity } from './slack-identity.entity';
import { Task } from './task.entity';
import { TeamTask } from './team-task.entity';
import { Tenant } from './tenant.entity';
import { Worklog } from './worklog.entity';

/** Every harness entity — pass to the TypeORM DataSource / `TypeOrmModule.forRoot({ entities })`.
 * Single DB: the `tenants` workspace registry lives here too (no separate control datasource). */
export const ENTITIES = [
  Fact,
  Task,
  TeamTask,
  Worklog,
  ChannelMessage,
  BotCursor,
  Channel,
  Project,
  GithubToken,
  ProviderKey,
  SlackIdentity,
  Tenant,
  EmployeeSkill,
];
