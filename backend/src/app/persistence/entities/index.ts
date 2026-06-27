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
export * from './thread.entity';
export * from './message.entity';
export * from './stimulus.entity';
export * from './track.entity';
export * from './step.entity';
export * from './decision-record.entity';
export * from './memory.entity';
export * from './org-credentials.entity';
export * from './org-worktree-secret.entity';
export * from './org-worktree-secret-grant.entity';
export * from './thread-sandbox.entity';
export * from './user.entity';
export * from './ticket.entity';
export * from './ticket-dependency.entity';
export * from './ticket-counter.entity';

import { OrganizationEntity } from './organization.entity';
import { OrganizationMemberEntity } from './organization-member.entity';
import { OrgInviteEntity } from './org-invite.entity';
import { RepoEntity } from './repo.entity';
import { ThreadEntity } from './thread.entity';
import { MessageEntity } from './message.entity';
import { StimulusEntity } from './stimulus.entity';
import { TrackEntity } from './track.entity';
import { StepEntity } from './step.entity';
import { DecisionRecordEntity } from './decision-record.entity';
import { MemoryEntity } from './memory.entity';
import { OrgCredentialsEntity } from './org-credentials.entity';
import { OrgWorktreeSecretEntity } from './org-worktree-secret.entity';
import { OrgWorktreeSecretGrantEntity } from './org-worktree-secret-grant.entity';
import { ThreadSandboxEntity } from './thread-sandbox.entity';
import { UserEntity } from './user.entity';
import { TicketEntity } from './ticket.entity';
import { TicketDependencyEntity } from './ticket-dependency.entity';
import { TicketCounterEntity } from './ticket-counter.entity';

/** Every Atlas v2 entity — passed to the Atlas datasource's `entities` (NOT the shared `ENTITIES`). */
export const ENTITIES = [
  OrganizationEntity,
  OrganizationMemberEntity,
  OrgInviteEntity,
  RepoEntity,
  ThreadEntity,
  MessageEntity,
  StimulusEntity,
  TrackEntity,
  StepEntity,
  DecisionRecordEntity,
  MemoryEntity,
  OrgCredentialsEntity,
  OrgWorktreeSecretEntity,
  OrgWorktreeSecretGrantEntity,
  ThreadSandboxEntity,
  UserEntity,
  TicketEntity,
  TicketDependencyEntity,
  TicketCounterEntity,
];
