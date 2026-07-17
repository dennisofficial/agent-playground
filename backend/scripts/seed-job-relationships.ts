import 'reflect-metadata';

import type { DataSource } from 'typeorm';
import { AppDataSource } from '../cli/data-source';
import {
  JobEntity,
  JobDependencyEntity,
  InboundMessageEntity,
} from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from '../seeds/_shared/dev-seed-ids';

// `SYSTEM_SEED_AUTHOR` (chat-surface.port.ts) and the born-blocked provenance wording
// (prompt-kit/harness/seed-catalog.ts's `renderBornBlockedProvenanceNote`) are inlined here rather than
// imported: both modules pull in the `@shared/*` path alias, which only resolves inside the compiled Nest
// app (webpack/ts-jest paths), not this script's plain standalone `ts-node` run. Same one-time-inline-copy
// tradeoff the `DropBlockedSeedMessage` migration makes for the same text — acceptable, no drift after
// this fixture is next touched.
const SYSTEM_SEED_AUTHOR = { id: 'U-SYSTEM', name: 'System' } as const;
const BORN_BLOCKED_PROVENANCE_NOTE =
  'This job was CREATED already blocked — it is held until the job(s) it depends on resolve. You have ' +
  'NOT started any work yet; the brief below is your starting point once it unblocks.';

/**
 * Standalone seeder for the job-RELATIONSHIPS UI scenario (provenance + blocked dependencies), so the
 * console renders the "Created by" / "Created jobs" / "Blocked by" surfaces from real rows. Idempotent —
 * every row uses a stable `bb000000-…` uuid, so re-running is a pure upsert-by-id.
 *
 *   pnpm exec ts-node --project tsconfig.cli.json scripts/seed-job-relationships.ts
 */

const ORG_ID = DEV_SEED_IDS.orgs.atlasTest;
const REPO_ID = DEV_SEED_IDS.repos.testRepo;

const id = (n: string): string => `bb000000-0000-4000-8000-0000000000${n}`;

const PARENT = id('01');
const CHILD_A = id('02');
const CHILD_B = id('03');
const ORPHAN_CHILD = id('04');
const BLOCKER = id('05');
const BLOCKED = id('06');
const DEP_EDGE = id('07');
/** The BLOCKED job's queued born-blocked provenance note + opening brief — the `inbound_messages` seed
 *  rows that replaced the `jobs.blocked_seed_message` column (see `StimulusStoreService
 *  .recordBornBlockedSeedsIfAbsent`, which this mirrors for the dev fixture). */
const BLOCKED_PROVENANCE_SEED = id('08');
const BLOCKED_BRIEF_SEED = id('09');

/** A jobId the "Created by" snapshot points at that does NOT exist — clicking it 404s → deleted-toast. */
const DELETED_PARENT_ID = 'bb0000de-ad00-4000-8000-000000000000';

type SeedJob = {
  id: string;
  title: string;
  status: string;
  createdByJobId?: string | null;
  createdBy?: { jobId: string; title: string | null } | null;
  /** BORN-BLOCKED opening brief — queued as an undelivered `inbound_messages` seed (the mechanism that
   *  replaced the `jobs.blocked_seed_message` column), not written onto the job row itself. */
  blockedBrief?: string | null;
  prState?: 'open' | null;
  prNumber?: number | null;
  prUrl?: string | null;
};

const JOBS: SeedJob[] = [
  {
    id: PARENT,
    title: 'Add OAuth login flow',
    status: 'awaiting_ship_review',
    prState: 'open',
    prNumber: 412,
    prUrl: 'https://github.com/dennisofficial/test-repo/pull/412',
  },
  {
    id: CHILD_A,
    title: 'Add OAuth logout + token revocation',
    status: 'planning',
    createdByJobId: PARENT,
    createdBy: { jobId: PARENT, title: 'Add OAuth login flow' },
  },
  {
    id: CHILD_B,
    title: 'Document OAuth environment variables',
    status: 'done',
    createdByJobId: PARENT,
    createdBy: { jobId: PARENT, title: 'Add OAuth login flow' },
  },
  {
    id: ORPHAN_CHILD,
    title: 'Rotate OAuth client secret',
    status: 'planning',
    // FK went null when the spawning job was hard-deleted; the immutable snapshot survives and powers
    // the deleted-job toast (its jobId no longer resolves).
    createdByJobId: null,
    createdBy: { jobId: DELETED_PARENT_ID, title: 'Deprecate legacy session cookies' },
  },
  {
    id: BLOCKER,
    title: 'Extract shared auth middleware',
    status: 'awaiting_ship_review',
    prState: 'open',
    prNumber: 418,
    prUrl: 'https://github.com/dennisofficial/test-repo/pull/418',
  },
  {
    id: BLOCKED,
    title: 'Wire feature flags into auth middleware',
    status: 'blocked',
    // Deliberately long, multi-paragraph so the blocked banner's "when this unblocks" preview overflows —
    // this is the scenario that must scroll on mobile rather than clip (see mobile-scroll-fixes.spec.ts).
    blockedBrief: [
      'Add per-flag gating to the shared auth middleware once it is extracted, so flags can toggle auth behavior per request.',
      '',
      'GOAL — thread the feature-flag evaluator through the shared auth middleware so a request can be allowed, denied, or shadow-logged based on the flags resolved for the authenticated principal. This must run AFTER the middleware has resolved identity but BEFORE any route handler executes, so a denied flag short-circuits with a 403 and never reaches domain code.',
      '',
      'WHY — flag decisions are currently duplicated in three call sites and drift apart; centralizing them in the middleware makes the policy one source of truth and lets us roll out auth changes behind a flag without touching every route.',
      '',
      'SCOPE — (1) inject the flag evaluator into the middleware; (2) resolve the principal→flags set once per request and stash it on the request context; (3) add per-flag gating hooks that routes can opt into declaratively; (4) emit a shadow-log line when a flag WOULD have changed the outcome, so we can measure impact before enforcing. Out of scope: the flag admin UI and the storage backend, which land in follow-up jobs.',
      '',
      'CONSTRAINTS — zero added latency on the hot path when no flags apply; the evaluator must be memoized per request; and the middleware must fail OPEN for read-only routes but fail CLOSED for mutations if the evaluator is unavailable.',
    ].join('\n'),
  },
];

async function upsertJob(ds: DataSource, seed: SeedJob): Promise<void> {
  const jobs = ds.getRepository(JobEntity);
  const row =
    (await jobs.findOne({ where: { id: seed.id } })) ??
    jobs.create({ id: seed.id });
  row.org_id = ORG_ID;
  row.repo_id = REPO_ID;
  row.origin = 'chat';
  row.kind = 'feature';
  row.title = seed.title;
  row.status = seed.status;
  row.created_by_job_id = seed.createdByJobId ?? null;
  row.created_by = seed.createdBy ?? null;
  row.pr_state = seed.prState ?? null;
  row.pr_number = seed.prNumber ?? null;
  row.pr_url = seed.prUrl ?? null;
  // Fixture PRs: park the reconciler's durable poll far in the future so it never 404s and re-latches.
  row.next_poll_at = seed.prNumber != null ? new Date('2999-01-01T00:00:00Z') : null;
  row.halted = false;
  row.halt = null;
  await jobs.save(row);
  console.log(`  seeded job "${seed.title}" [${seed.status}] (${seed.id})`);

  if (seed.blockedBrief != null) await upsertBornBlockedQueue(ds, seed);
}

/**
 * BORN-BLOCKED queue rows for a blocked fixture job: an undelivered provenance note + the opening brief
 * (oldest-first), mirroring `StimulusStoreService.recordBornBlockedSeedsIfAbsent` — the mechanism the
 * blocked-overlay preview DTO (`blockedSeedMessage`) now reads from instead of the retired
 * `jobs.blocked_seed_message` column. Upsert-by-stable-id, same idempotency convention as the rest of
 * this script. (This fixture's blocked job has no `createdBy`, so the no-parent provenance wording
 * always applies — add the parented variant here too if a future fixture job needs it.)
 */
async function upsertBornBlockedQueue(ds: DataSource, seed: SeedJob): Promise<void> {
  const stimuli = ds.getRepository(InboundMessageEntity);
  const replyRoute = { surfaceId: 'web', jobRef: seed.id };
  const rows: Array<{ id: string; body: string; bornBlockedSeed?: true }> = [
    {
      id: BLOCKED_PROVENANCE_SEED,
      body: BORN_BLOCKED_PROVENANCE_NOTE,
      bornBlockedSeed: true,
    },
    { id: BLOCKED_BRIEF_SEED, body: seed.blockedBrief! },
  ];
  for (const r of rows) {
    const row =
      (await stimuli.findOne({ where: { id: r.id } })) ??
      stimuli.create({ id: r.id });
    row.org_id = ORG_ID;
    row.repo_id = REPO_ID;
    row.job_id = seed.id;
    row.kind = 'chat';
    row.type = 'follow_up_job_seed';
    row.trust = 'trusted';
    row.body = r.body;
    row.lane = 'main';
    row.author_id = SYSTEM_SEED_AUTHOR.id;
    row.author_name = SYSTEM_SEED_AUTHOR.name;
    row.reply_route = (
      r.bornBlockedSeed ? { ...replyRoute, bornBlockedSeed: true } : replyRoute
    ) as InboundMessageEntity['reply_route'];
    row.delivered_at = null;
    row.attempted_at = null;
    await stimuli.save(row);
  }
  console.log(`  seeded born-blocked queue (provenance + brief) for ${seed.id}`);
}

async function upsertEdge(ds: DataSource): Promise<void> {
  const edges = ds.getRepository(JobDependencyEntity);
  const row =
    (await edges.findOne({ where: { id: DEP_EDGE } })) ??
    edges.create({ id: DEP_EDGE });
  row.org_id = ORG_ID;
  row.repo_id = REPO_ID;
  row.job_id = BLOCKED; // the blocked job
  row.depends_on_job_id = BLOCKER; // the blocker
  await edges.save(row);
  console.log(`  seeded dependency edge: ${BLOCKED} blocked-by ${BLOCKER}`);
}

async function main(): Promise<void> {
  const ds = await AppDataSource.initialize();
  try {
    for (const seed of JOBS) await upsertJob(ds, seed);
    await upsertEdge(ds);
    console.log('seed-job-relationships: done');
    console.log(`  parent=${PARENT} childA=${CHILD_A} childB=${CHILD_B}`);
    console.log(`  orphanChild=${ORPHAN_CHILD} blocker=${BLOCKER} blocked=${BLOCKED}`);
  } finally {
    await ds.destroy();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
