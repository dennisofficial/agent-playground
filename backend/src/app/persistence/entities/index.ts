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
export * from './section.entity';
export * from './phase.entity';
export * from './decision-record.entity';
export * from './memory.entity';
export * from './org-credentials.entity';
export * from './thread-sandbox.entity';
export * from './user.entity';

import { OrganizationEntity } from './organization.entity';
import { OrganizationMemberEntity } from './organization-member.entity';
import { OrgInviteEntity } from './org-invite.entity';
import { RepoEntity } from './repo.entity';
import { ThreadEntity } from './thread.entity';
import { MessageEntity } from './message.entity';
import { StimulusEntity } from './stimulus.entity';
import { SectionEntity } from './section.entity';
import { PhaseEntity } from './phase.entity';
import { DecisionRecordEntity } from './decision-record.entity';
import { MemoryEntity } from './memory.entity';
import { OrgCredentialsEntity } from './org-credentials.entity';
import { ThreadSandboxEntity } from './thread-sandbox.entity';
import { UserEntity } from './user.entity';

/** Every Atlas v2 entity — passed to the Atlas datasource's `entities` (NOT the shared `ENTITIES`). */
export const ENTITIES = [
  OrganizationEntity,
  OrganizationMemberEntity,
  OrgInviteEntity,
  RepoEntity,
  ThreadEntity,
  MessageEntity,
  StimulusEntity,
  SectionEntity,
  PhaseEntity,
  DecisionRecordEntity,
  MemoryEntity,
  OrgCredentialsEntity,
  ThreadSandboxEntity,
  UserEntity,
];
