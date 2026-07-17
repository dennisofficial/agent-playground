/**
 * Atlas v2's OWN entity set — namespaced `app`, loaded ONLY by the Atlas datasource
 * (`OrmConnectionModule` + `cli/data-source.ts`), never added to the shared global `ENTITIES`.
 * They reuse the foundational `TimestampedEntity` base (a shared package, allowed) but import nothing
 * from v1 orchestration.
 */
export * from './active-turn.entity';
export * from './convention-profile.entity';
export * from './decision-record.entity';
export * from './host-stats-sample.entity';
export * from './inbound-message.entity';
export * from './job-dependency.entity';
export * from './job-sandbox.entity';
export * from './job.entity';
export * from './mcp-server.entity';
export * from './memory.entity';
export * from './org-claude-credential.entity';
export * from './org-credentials.entity';
export * from './org-invite.entity';
export * from './org-workspace-mount.entity';
export * from './org-workspace-secret-file.entity';
export * from './organization-member.entity';
export * from './organization.entity';
export * from './prod-maintenance-write.entity';
export * from './repo.entity';
export * from './subagent.entity';
export * from './task.entity';
export * from './thread-group.entity';
export * from './thread.entity';
export * from './tool-execution.entity';
export * from './transcript-message.entity';
export * from './turn-model-usage.entity';
export * from './turn-stats.entity';
export * from './user.entity';
export * from './workspace-skill.entity';

import { ActiveTurnEntity } from './active-turn.entity';
import { ConventionProfileEntity } from './convention-profile.entity';
import { DecisionRecordEntity } from './decision-record.entity';
import { HostStatsSampleEntity } from './host-stats-sample.entity';
import { InboundMessageEntity } from './inbound-message.entity';
import { JobDependencyEntity } from './job-dependency.entity';
import { JobSandboxEntity } from './job-sandbox.entity';
import { JobEntity } from './job.entity';
import { McpServerEntity } from './mcp-server.entity';
import { MemoryEntity } from './memory.entity';
import { OrgClaudeCredentialEntity } from './org-claude-credential.entity';
import { OrgCredentialsEntity } from './org-credentials.entity';
import { OrgInviteEntity } from './org-invite.entity';
import { OrgWorkspaceMountEntity } from './org-workspace-mount.entity';
import { OrgWorkspaceSecretFileEntity } from './org-workspace-secret-file.entity';
import { OrganizationMemberEntity } from './organization-member.entity';
import { OrganizationEntity } from './organization.entity';
import { ProdMaintenanceWriteEntity } from './prod-maintenance-write.entity';
import { RepoEntity } from './repo.entity';
import { SubagentEntity } from './subagent.entity';
import { TaskEntity } from './task.entity';
import { ThreadGroupEntity } from './thread-group.entity';
import { ThreadEntity } from './thread.entity';
import { ToolExecutionEntity } from './tool-execution.entity';
import { TranscriptMessageEntity } from './transcript-message.entity';
import { TurnModelUsageEntity } from './turn-model-usage.entity';
import { TurnStatsEntity } from './turn-stats.entity';
import { UserEntity } from './user.entity';
import { WorkspaceSkillEntity } from './workspace-skill.entity';

/** Every Atlas v2 entity — passed to the Atlas datasource's `entities` (NOT the shared `ENTITIES`). */
export const ENTITIES = [
  OrganizationEntity,
  OrganizationMemberEntity,
  OrgInviteEntity,
  RepoEntity,
  JobEntity,
  TranscriptMessageEntity,
  ActiveTurnEntity,
  ToolExecutionEntity,
  InboundMessageEntity,
  ThreadGroupEntity,
  ThreadEntity,
  TaskEntity,
  SubagentEntity,
  DecisionRecordEntity,
  MemoryEntity,
  OrgCredentialsEntity,
  OrgClaudeCredentialEntity,
  OrgWorkspaceSecretFileEntity,
  OrgWorkspaceMountEntity,
  JobSandboxEntity,
  UserEntity,
  JobDependencyEntity,
  TurnStatsEntity,
  TurnModelUsageEntity,
  McpServerEntity,
  ConventionProfileEntity,
  WorkspaceSkillEntity,
  HostStatsSampleEntity,
  ProdMaintenanceWriteEntity,
];
