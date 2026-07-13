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
export * from './message.entity';
export * from './codex-review.entity';
export * from './active-turn.entity';
export * from './tool-execution.entity';
export * from './stimulus.entity';
export * from './thread.entity';
export * from './step.entity';
export * from './build-leg.entity';
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

import { OrganizationEntity } from './organization.entity';
import { OrganizationMemberEntity } from './organization-member.entity';
import { OrgInviteEntity } from './org-invite.entity';
import { RepoEntity } from './repo.entity';
import { JobEntity } from './job.entity';
import { MessageEntity } from './message.entity';
import { CodexReviewEntity } from './codex-review.entity';
import { ActiveTurnEntity } from './active-turn.entity';
import { ToolExecutionEntity } from './tool-execution.entity';
import { StimulusEntity } from './stimulus.entity';
import { ThreadEntity } from './thread.entity';
import { StepEntity } from './step.entity';
import { BuildLegEntity } from './build-leg.entity';
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

/** Every Atlas v2 entity — passed to the Atlas datasource's `entities` (NOT the shared `ENTITIES`). */
export const ENTITIES = [
  OrganizationEntity,
  OrganizationMemberEntity,
  OrgInviteEntity,
  RepoEntity,
  JobEntity,
  MessageEntity,
  CodexReviewEntity,
  ActiveTurnEntity,
  ToolExecutionEntity,
  StimulusEntity,
  ThreadEntity,
  StepEntity,
  BuildLegEntity,
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
