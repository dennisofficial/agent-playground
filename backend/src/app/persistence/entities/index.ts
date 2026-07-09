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
export * from './repo-adr.entity';
export * from './memory.entity';
export * from './org-credentials.entity';
export * from './org-worktree-secret-file.entity';
export * from './org-worktree-mount.entity';
export * from './job-sandbox.entity';
export * from './user.entity';
export * from './ticket.entity';
export * from './ticket-dependency.entity';
export * from './ticket-counter.entity';
export * from './turn-stats.entity';
export * from './turn-model-usage.entity';
export * from './mcp-server.entity';
export * from './convention-profile.entity';
export * from './workspace-skill.entity';

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
import { RepoAdrEntity } from './repo-adr.entity';
import { MemoryEntity } from './memory.entity';
import { OrgCredentialsEntity } from './org-credentials.entity';
import { OrgWorktreeSecretFileEntity } from './org-worktree-secret-file.entity';
import { OrgWorktreeMountEntity } from './org-worktree-mount.entity';
import { JobSandboxEntity } from './job-sandbox.entity';
import { UserEntity } from './user.entity';
import { TicketEntity } from './ticket.entity';
import { TicketDependencyEntity } from './ticket-dependency.entity';
import { TicketCounterEntity } from './ticket-counter.entity';
import { TurnStatsEntity } from './turn-stats.entity';
import { TurnModelUsageEntity } from './turn-model-usage.entity';
import { McpServerEntity } from './mcp-server.entity';
import { ConventionProfileEntity } from './convention-profile.entity';
import { WorkspaceSkillEntity } from './workspace-skill.entity';

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
  RepoAdrEntity,
  MemoryEntity,
  OrgCredentialsEntity,
  OrgWorktreeSecretFileEntity,
  OrgWorktreeMountEntity,
  JobSandboxEntity,
  UserEntity,
  TicketEntity,
  TicketDependencyEntity,
  TicketCounterEntity,
  TurnStatsEntity,
  TurnModelUsageEntity,
  McpServerEntity,
  ConventionProfileEntity,
  WorkspaceSkillEntity,
];
