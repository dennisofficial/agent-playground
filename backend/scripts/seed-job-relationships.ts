import 'reflect-metadata';

import type { DataSource } from 'typeorm';
import { AppDataSource } from '../cli/data-source';
import {
  JobEntity,
  JobDependencyEntity,
} from '../src/app/persistence/entities';
import { DEV_SEED_IDS } from '../seeds/_shared/dev-seed-ids';

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

/** A jobId the "Created by" snapshot points at that does NOT exist — clicking it 404s → deleted-toast. */
const DELETED_PARENT_ID = 'bb0000de-ad00-4000-8000-000000000000';

type SeedJob = {
  id: string;
  title: string;
  status: string;
  createdByJobId?: string | null;
  createdBy?: { jobId: string; title: string | null } | null;
  blockedSeedMessage?: string | null;
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
    blockedSeedMessage:
      'Add per-flag gating to the shared auth middleware once it is extracted, so flags can toggle auth behavior per request.',
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
  row.blocked_seed_message = seed.blockedSeedMessage ?? null;
  row.pr_state = seed.prState ?? null;
  row.pr_number = seed.prNumber ?? null;
  row.pr_url = seed.prUrl ?? null;
  // Fixture PRs: park the reconciler's durable poll far in the future so it never 404s and re-latches.
  row.next_poll_at = seed.prNumber != null ? new Date('2999-01-01T00:00:00Z') : null;
  row.halted = false;
  row.halt = null;
  await jobs.save(row);
  console.log(`  seeded job "${seed.title}" [${seed.status}] (${seed.id})`);
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
