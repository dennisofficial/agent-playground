/**
 * Atlas v2's OWN entity set — namespaced `app`, loaded ONLY by the Atlas datasource
 * (`OrmConnectionModule` + `cli/data-source.ts`), never added to the shared global `ENTITIES`.
 * They reuse the foundational `TimestampedEntity` base (a shared package, allowed) but import nothing
 * from v1 orchestration.
 */
export * from './organization.entity';
export * from './organization-member.entity';
export * from './org-invite.entity';
export * from './repo.entity';
export * from './job.entity';
export * from './transcript-message.entity';
export * from './active-turn.entity';
export * from './tool-execution.entity';
export * from './inbound-message.entity';
export * from './thread-group.entity';
export * from './thread.entity';
export * from './task.entity';
export * from './subagent.entity';
export * from './decision-record.entity';
export * from './memory.entity';
export * from './org-credentials.entity';
export * from './org-claude-credential.entity';
export * from './org-workspace-secret-file.entity';
export * from './org-workspace-mount.entity';
export * from './job-sandbox.entity';
export * from './user.entity';
export * from './job-dependency.entity';
export * from './turn-stats.entity';
export * from './turn-model-usage.entity';
export * from './mcp-server.entity';
export * from './convention-profile.entity';
export * from './workspace-skill.entity';
export * from './host-stats-sample.entity';
export * from './prod-maintenance-write.entity';
export * from './composer-draft.entity';
export * from './composer-draft-attachment.entity';

import { OrganizationEntity } from './organization.entity';
import { OrganizationMemberEntity } from './organization-member.entity';
import { OrgInviteEntity } from './org-invite.entity';
import { RepoEntity } from './repo.entity';
import { JobEntity } from './job.entity';
import { TranscriptMessageEntity } from './transcript-message.entity';
import { ActiveTurnEntity } from './active-turn.entity';
import { ToolExecutionEntity } from './tool-execution.entity';
import { InboundMessageEntity } from './inbound-message.entity';
import { ThreadGroupEntity } from './thread-group.entity';
import { ThreadEntity } from './thread.entity';
import { TaskEntity } from './task.entity';
import { SubagentEntity } from './subagent.entity';
import { DecisionRecordEntity } from './decision-record.entity';
import { MemoryEntity } from './memory.entity';
import { OrgCredentialsEntity } from './org-credentials.entity';
import { OrgClaudeCredentialEntity } from './org-claude-credential.entity';
import { OrgWorkspaceSecretFileEntity } from './org-workspace-secret-file.entity';
import { OrgWorkspaceMountEntity } from './org-workspace-mount.entity';
import { JobSandboxEntity } from './job-sandbox.entity';
import { UserEntity } from './user.entity';
import { JobDependencyEntity } from './job-dependency.entity';
import { TurnStatsEntity } from './turn-stats.entity';
import { TurnModelUsageEntity } from './turn-model-usage.entity';
import { McpServerEntity } from './mcp-server.entity';
import { ConventionProfileEntity } from './convention-profile.entity';
import { WorkspaceSkillEntity } from './workspace-skill.entity';
import { HostStatsSampleEntity } from './host-stats-sample.entity';
import { ProdMaintenanceWriteEntity } from './prod-maintenance-write.entity';
import { ComposerDraftEntity } from './composer-draft.entity';
import { ComposerDraftAttachmentEntity } from './composer-draft-attachment.entity';

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
  ComposerDraftEntity,
  ComposerDraftAttachmentEntity,
];
