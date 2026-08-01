import { NO_CLIENT_ACCESS, definePolicy, type PolicyRegistry } from '@dltech/pgbase/policy';
import type { Prisma } from '../../generated/prisma/client';
import type {
  AgentCredentialModel,
  InboundMessageModel,
  JobModel,
  OrganizationMemberModel,
  OrganizationModel,
  RepoModel,
  SubagentModel,
  TaskModel,
  ThreadGroupModel,
  ThreadMessageModel,
  ThreadModel,
} from '../../generated/prisma/models';
import type { AtlasClaims } from './atlas-claims';

/**
 * The entire read-side authorization surface. Nothing downstream re-checks it: a client subscribes
 * or reads, and these predicates are what decides which rows exist as far as that caller is
 * concerned.
 *
 * Two things carried over from the `@Rls`/`@Expose` decorators this replaces:
 *
 * `omit` is the COMPLEMENT of the old `@Expose` allowlist. `@Expose` failed closed — an unmarked
 * column stayed hidden — whereas `omit` fails OPEN, so a column missing from a list here is
 * published to every subscriber. The lists below were derived mechanically from the entity files
 * rather than transcribed.
 *
 * `rls` is the old policy's READ predicate. Three entities (Job, Repo, AgentCredential) used a
 * narrower predicate for writes than for reads, which a single-predicate registry cannot express;
 * that narrowing now lives in the command services. Using the write predicate here instead would
 * have hidden rows the UI needs; using the read predicate for writes would have let a non-owner
 * write repos and credentials.
 */

const agentCredentialPolicy = definePolicy<AgentCredentialModel, AtlasClaims>('AgentCredential')({
  // `materialEnc` is the AES-GCM credential blob and must never reach a client; `scopes` and
  // `lastRefreshedAt` are refresh-loop bookkeeping the UI has no use for.
  omit: ['scopes', 'materialEnc', 'lastRefreshedAt', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const inboundMessagePolicy = definePolicy<InboundMessageModel, AtlasClaims>('InboundMessage')({
  omit: ['deliveredAt', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const jobPolicy = definePolicy<JobModel, AtlasClaims>('Job')({
  omit: [],
  // Archived jobs are hidden from reads, as they were before. Because pgbase proves an update's
  // pre-image is visible under this same predicate, an archived job is not writable through
  // ScopedDb — un-archiving goes through PrismaService with an explicit org check.
  rls: (claims) => ({ orgId: { in: claims.orgIds }, archivedAt: null }),
});

const organizationPolicy = definePolicy<OrganizationModel, AtlasClaims>('Organization')({
  omit: ['createdAt', 'updatedAt'],
  rls: (claims) => ({ id: { in: claims.orgIds } }),
});

const organizationMemberPolicy = definePolicy<OrganizationMemberModel, AtlasClaims>(
  'OrganizationMember',
)({
  omit: ['createdAt', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const repoPolicy = definePolicy<RepoModel, AtlasClaims>('Repo')({
  omit: ['createdAt', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const taskPolicy = definePolicy<TaskModel, AtlasClaims>('Task')({
  omit: ['createdAt', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const threadPolicy = definePolicy<ThreadModel, AtlasClaims>('Thread')({
  omit: [],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const threadGroupPolicy = definePolicy<ThreadGroupModel, AtlasClaims>('ThreadGroup')({
  omit: ['createdAt', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

/**
 * The one model here that carried no `@Expose` and still gets a policy.
 *
 * Its `status` and `endedAt` were already reaching the browser before this migration, joined onto
 * `ThreadMessage` by the old realtime layer to drive the subagent cards. pgbase cannot keep a join
 * live, so the client subscribes to the rows directly and composes them — which means exposing
 * exactly the two columns that were already visible, and nothing else. This is not a widening.
 *
 * Everything else stays hidden, and that is the point of the explicit list: `costUsd` and the four
 * token counters are spend data, and `sessionRef`, `model` and `agentType` describe the harness.
 */
const subagentPolicy = definePolicy<SubagentModel, AtlasClaims>('Subagent')({
  omit: [
    'threadId',
    'parentMessageId',
    'toolUseId',
    'agentType',
    'model',
    'sessionRef',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
    'startedAt',
    'createdAt',
    'updatedAt',
  ],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

const threadMessagePolicy = definePolicy<ThreadMessageModel, AtlasClaims>('ThreadMessage')({
  // `audience` decides whether a message is operator-only, and `authorId` identifies the actor
  // behind a system message — both are routing inputs, not content the client is entitled to.
  omit: ['audience', 'authorId', 'updatedAt'],
  rls: (claims) => ({ orgId: { in: claims.orgIds } }),
});

export const atlasPolicies = {
  AgentCredential: agentCredentialPolicy,
  InboundMessage: inboundMessagePolicy,
  Job: jobPolicy,
  Organization: organizationPolicy,
  OrganizationMember: organizationMemberPolicy,
  Repo: repoPolicy,
  Subagent: subagentPolicy,
  Task: taskPolicy,
  Thread: threadPolicy,
  ThreadGroup: threadGroupPolicy,
  ThreadMessage: threadMessagePolicy,

  // No client access. These carried no `@Expose` column, so none of them was ever readable from the
  // browser and none becomes readable now. They are absent from ScopedDb too, so server code that
  // touches them injects PrismaService and scopes explicitly.
  McpServer: NO_CLIENT_ACCESS,
  // Holds the org's encrypted Anthropic/OpenAI/GitHub credentials.
  OrgCredential: NO_CLIENT_ACCESS,
  Skill: NO_CLIENT_ACCESS,
  // Holds `passwordHash`.
  User: NO_CLIENT_ACCESS,
  WorkspaceMount: NO_CLIENT_ACCESS,
  WorkspaceProfile: NO_CLIENT_ACCESS,
  // Holds `valueEnc` — decrypted secret files mounted into sandboxes.
  WorkspaceSecretFile: NO_CLIENT_ACCESS,
} satisfies PolicyRegistry<Prisma.ModelName>;
