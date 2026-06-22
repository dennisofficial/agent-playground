/**
 * Atlas v2's OWN entity set — namespaced `atlas_*`, loaded ONLY by the Atlas datasource
 * (`AtlasDatabaseModule` + `cli/atlas-data-source.ts`), never added to the shared global `ENTITIES`.
 * They reuse the foundational `TimestampedEntity` base (a shared package, allowed) but import nothing
 * from v1 orchestration.
 */
export * from './atlas-team.entity';
export * from './atlas-project.entity';
export * from './atlas-channel.entity';
export * from './atlas-thread.entity';
export * from './atlas-message.entity';
export * from './atlas-stimulus.entity';
export * from './atlas-job.entity';
export * from './atlas-section.entity';
export * from './atlas-phase.entity';
export * from './atlas-decision-record.entity';
export * from './atlas-memory.entity';
export * from './atlas-tenant-credentials.entity';
export * from './atlas-thread-sandbox.entity';
export * from './atlas-user.entity';

import { AtlasTeam } from './atlas-team.entity';
import { AtlasProject } from './atlas-project.entity';
import { AtlasChannel } from './atlas-channel.entity';
import { AtlasThread } from './atlas-thread.entity';
import { AtlasMessage } from './atlas-message.entity';
import { AtlasStimulus } from './atlas-stimulus.entity';
import { AtlasJob } from './atlas-job.entity';
import { AtlasSection } from './atlas-section.entity';
import { AtlasPhase } from './atlas-phase.entity';
import { AtlasDecisionRecord } from './atlas-decision-record.entity';
import { AtlasMemory } from './atlas-memory.entity';
import { AtlasTenantCredentials } from './atlas-tenant-credentials.entity';
import { AtlasThreadSandbox } from './atlas-thread-sandbox.entity';
import { AtlasUser } from './atlas-user.entity';

/** Every Atlas v2 entity — passed to the Atlas datasource's `entities` (NOT the shared `ENTITIES`). */
export const ATLAS_ENTITIES = [
  AtlasTeam,
  AtlasProject,
  AtlasChannel,
  AtlasThread,
  AtlasMessage,
  AtlasStimulus,
  AtlasJob,
  AtlasSection,
  AtlasPhase,
  AtlasDecisionRecord,
  AtlasMemory,
  AtlasTenantCredentials,
  AtlasThreadSandbox,
  AtlasUser,
];
