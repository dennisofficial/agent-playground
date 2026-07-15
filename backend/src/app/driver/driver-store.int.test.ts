/**
 * DriverStoreService.getPipelineState — the web `/pipeline` read model.
 *
 * Proves (against live Postgres) that the payload the operator console renders the navigator from carries
 * the job's ordinal-ordered THREAD GROUPS, each thread group's threads (root builder legs + their review children) with
 * the thread `hasPlan` flag, the thread group's task checklist, and the PR + branch on the job. Also exercises the
 * driver's write surface: thread-group/thread/task CRUD, builder-leg rotation, the halt/done-wake CAS methods, and
 * the ship-review gate.
 *
 * Integration: real Postgres (atlas_test schema), no fakes (the methods only touch repositories). Seeds an
 * org/repo/job + thread groups/threads/tasks (via the store's own CRUD where practical), then asserts the mapped
 * read model.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ENTITIES,
  ThreadEntity,
  JobEntity,
  MessageEntity,
} from '../persistence/entities';
import { JobDependencyService } from '../job-deps';
import { DriverStoreService } from './driver-store.service';
import { webShipReviewCard } from '../surface/web-approval-card';

const ORG_ID = '21111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

describe('DriverStoreService.getPipelineState (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: DriverStoreService;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
  let messages: Repository<MessageEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [
        DriverStoreService,
        {
          provide: JobDependencyService,
          useValue: { blockersOf: async () => [] },
        },
      ],
    }).compile();

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
    messages = mod.get(getRepositoryToken(MessageEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Driver Store Org', 'driver-store-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'driver-store-repo', 'Driver Store Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE tasks, threads, thread_groups, jobs RESTART IDENTITY CASCADE',
    );
  });

  it('returns hasPlan + review children per thread and the PR + branch on the job', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'Stripe webhooks',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
        feature_branch: 'atlas/feature-stripe',
        pr_url: 'https://github.com/x/y/pull/43',
        pr_number: 43,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — wire the webhook handler',
    });
    await store.setThreadPlan(thread.id, 'detailed plan prose', null); // → hasPlan: true
    await store.setThreadStatus(thread.id, 'executing');

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      status: string;
      prUrl: string | null;
      prNumber: number | null;
      featureBranch: string | null;
      baseBranch: string | null;
      threadGroups: Array<{
        threads: Array<{
          id: string;
          hasPlan: boolean;
          status: string;
          children: unknown[];
        }>;
      }>;
    };

    expect(state.status).toBe('running');
    expect(state.prUrl).toBe('https://github.com/x/y/pull/43');
    expect(state.prNumber).toBe(43);
    expect(state.featureBranch).toBe('atlas/feature-stripe');
    expect(state.baseBranch).toBe(BASE_BRANCH);

    expect(state.threadGroups).toHaveLength(1);
    expect(state.threadGroups[0].threads).toHaveLength(1);
    const [sec] = state.threadGroups[0].threads;
    expect(sec.hasPlan).toBe(true);
    expect(sec.status).toBe('executing');
    // Before the review thread group materializes child rows, the read model exposes NO children — the current
    // code does not synthesize a preview child. Materialized review rows are covered by the next test.
    expect(sec.children).toEqual([]);
  });

  it('surfaces the committed `build_path` as `buildPath` — direct builds carry no thread groups', async () => {
    // A DIRECT build: approved fast path, committed `build_path='direct'`, done, with NO thread groups.
    // The navigator reads `buildPath` to suppress its plan-oriented placeholders for exactly this shape.
    const direct = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'Direct build',
        kind: 'feature',
        status: 'done',
        base_branch: BASE_BRANCH,
        build_path: 'direct',
      }),
    );
    const directState = (await store.getPipelineState(direct.id, ORG_ID)) as {
      buildPath: string | null;
      threadGroups: unknown[];
    };
    expect(directState.buildPath).toBe('direct');
    expect(directState.threadGroups).toHaveLength(0);

    // A job that never committed a path (still convertible) reports `buildPath: null` — the navigator keeps
    // its placeholders in that case.
    const unset = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'Unapproved proposal',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const unsetState = (await store.getPipelineState(unset.id, ORG_ID)) as {
      buildPath: string | null;
    };
    expect(unsetState.buildPath).toBeNull();
  });

  it('materializes review children (idempotent) and derives per-lens status + findings from their own rows', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'review children',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — review children',
    });
    await store.setThreadStatus(thread.id, 'auto_fixing');

    const childSpecs = [
      {
        kind: 'review_agent',
        brief: 'BP',
        config: { lensId: 'best_practices' },
      },
      { kind: 'review_agent', brief: 'C', config: { lensId: 'correctness' } },
      { kind: 'review_agent', brief: 'Cs', config: { lensId: 'consistency' } },
      {
        kind: 'review_fix',
        brief: 'Post-review fixes',
        config: { minSeverity: 'medium' },
      },
    ];
    const children = await store.materializeReviewChildren(
      { id: thread.id, jobId: job.id, orgId: ORG_ID },
      childSpecs,
    );
    expect(children).toHaveLength(4);
    // Idempotent: a second materialize (a resume / concurrent drive) returns the SAME rows, no duplicates
    // (the (job_id, parent_thread_id, ordinal) unique index would reject dups).
    const again = await store.materializeReviewChildren(
      { id: thread.id, jobId: job.id, orgId: ORG_ID },
      childSpecs,
    );
    expect(again.map((c) => c.id).sort()).toEqual(
      children.map((c) => c.id).sort(),
    );

    const lenses = children.filter((c) => c.kind === 'review_agent');
    const finding = (severity: 'low' | 'medium' | 'high') => ({
      lens: 'x',
      severity,
      file: null,
      title: 't',
      detail: 'd',
    });

    // REGRESSION: two lenses complete CONCURRENTLY — each lands its OWN status + findings on its OWN row.
    // The old shared-jsonb read-modify-write lost one update here (a lens stuck 'reviewing'); with real
    // rows there is nothing to clobber.
    await Promise.all([
      (async () => {
        await store.setThreadReviewFindings(lenses[0].id, [finding('high')]);
        await store.setThreadStatus(lenses[0].id, 'done');
      })(),
      (async () => {
        await store.setThreadReviewFindings(lenses[1].id, [
          finding('low'),
          finding('medium'),
        ]);
        await store.setThreadStatus(lenses[1].id, 'done');
      })(),
    ]);
    await store.setThreadStatus(lenses[2].id, 'executing'); // third still running

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      threadGroups: Array<{
        threads: Array<{
          children: Array<{
            id: string;
            role: string;
            status: string;
            lensId?: string;
            findings: number | null;
            lane: string;
          }>;
        }>;
      }>;
    };
    // The child rows are NOT thread group roots (they nest under their builder as `children`).
    expect(state.threadGroups).toHaveLength(1);
    expect(state.threadGroups[0].threads).toHaveLength(1);
    const lensRows = state.threadGroups[0].threads[0].children.filter(
      (c) => c.role === 'review_agent',
    );
    const byLens = new Map(lensRows.map((c) => [c.lensId, c]));
    // Each lens landed its own status + findings on its own row (no shared array → no lost update).
    expect(byLens.get('best_practices')).toMatchObject({
      status: 'done',
      findings: 1,
    });
    expect(byLens.get('correctness')).toMatchObject({
      status: 'done',
      findings: 2,
    });
    expect(byLens.get('consistency')?.status).toBe('executing');
    // Each lens carries its own streaming lane; the review_fix child rides the fix lane.
    expect(byLens.get('best_practices')?.lane).toBe(
      `autofix:${thread.id}:best_practices`,
    );
    expect(
      state.threadGroups[0].threads[0].children.find((c) => c.role === 'review_fix')
        ?.lane,
    ).toBe(`autofix:${thread.id}:fix`);

    // reviewChildren reads the full findings back off each lens row (the fix pass's source of truth).
    const fresh = await store.reviewChildren(thread.id);
    const bp = fresh.find(
      (c) => (c.config as { lensId?: string }).lensId === 'best_practices',
    );
    expect(bp?.reviewFindings).toHaveLength(1);
    expect(fresh.find((c) => c.kind === 'review_fix')).toBeTruthy();
  });

  it('surfaces the thread-group-owned task checklist through the pipeline read model and the thread→thread group join', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'task list',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — task list',
    });
    await store.setThreadStatus(thread.id, 'executing');

    // An un-touched thread group: `tasks` is `[]` (no computed fallback — unlike reviewAgents, there's no
    // fixed/expected set for pure LLM output).
    const empty = (await store.getPipelineState(job.id, ORG_ID)) as {
      threadGroups: Array<{ tasks: unknown[] }>;
    };
    expect(empty.threadGroups[0].tasks).toEqual([]);

    // The build turn's TaskCreate writes a real thread-group-owned task row (no jsonb read-modify-write).
    const task = await store.createTask({
      threadGroupId: threadGroup.id,
      orgId: ORG_ID,
      title: 'Write the migration',
    });

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      threadGroups: Array<{
        tasks: Array<{ id: string; subject: string; status: string }>;
      }>;
    };
    // Mapped through `toTaskItem` — no `description`/`activeForm`/`blockedBy` keys since none were supplied.
    expect(state.threadGroups[0].tasks).toEqual([
      { id: task.id, subject: 'Write the migration', status: 'pending' },
    ]);
    // The thread → thread group → tasks join returns the SAME list (the fresh Leg reads it via its thread group).
    expect(await store.getThreadTasks(thread.id)).toEqual([
      { id: task.id, subject: 'Write the migration', status: 'pending' },
    ]);
  });

  it('dropOpenThreadTasks flips open (pending/in_progress) tasks to `dropped`, leaves completed, returns the count', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'drop open tasks',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — drop open tasks',
    });
    const t1 = await store.createTask({
      threadGroupId: threadGroup.id,
      orgId: ORG_ID,
      title: 'Done work',
    });
    const t2 = await store.createTask({
      threadGroupId: threadGroup.id,
      orgId: ORG_ID,
      title: 'Forgotten tick',
    });
    const t3 = await store.createTask({
      threadGroupId: threadGroup.id,
      orgId: ORG_ID,
      title: 'Never started',
    });
    await store.updateTaskStatus(t1.id, 'completed');
    await store.updateTaskStatus(t2.id, 'in_progress');
    // t3 stays pending

    const dropped = await store.dropOpenThreadTasks(thread.id);
    expect(dropped).toBe(2);
    expect(await store.getThreadTasks(thread.id)).toEqual([
      { id: t1.id, subject: 'Done work', status: 'completed' },
      { id: t2.id, subject: 'Forgotten tick', status: 'dropped' },
      { id: t3.id, subject: 'Never started', status: 'dropped' },
    ]);

    // Idempotent: a second pass finds nothing open, returns 0, and writes nothing new.
    expect(await store.dropOpenThreadTasks(thread.id)).toBe(0);
  });

  it('persists the repo-orientation cheat-sheet and surfaces it on the mapped thread (resume-durable)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'orientation',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — orientation',
    });

    // Fresh thread has no orientation yet (null → the builder would orient off the docs itself).
    const before = await store.threadsForJob(job.id);
    expect(before[0].orientation).toBeNull();

    // The plan turn captured a cheat-sheet → persisted so a resume (which skips re-planning) still has it.
    await store.setThreadOrientation(
      thread.id,
      'Monorepo — verify: pnpm -C backend test:unit',
    );
    const after = await store.threadsForJob(job.id);
    expect(after[0].orientation).toBe(
      'Monorepo — verify: pnpm -C backend test:unit',
    );
  });

  it('still reports `no_job` for a thread that has not entered the build lifecycle', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'just chatting',
        status: 'open',
        base_branch: BASE_BRANCH,
      }),
    );
    // `no_job` still carries the brain's own task list/default footer plus job-level header controls — the
    // navigator's Main row and auto-approve toggle work pre-plan, before the job has entered the build lifecycle.
    expect(await store.getPipelineState(job.id, ORG_ID)).toEqual({
      status: 'no_job',
      mainTasks: [],
      mainDefaultFooter: { engine: 'claude', model: 'opus', effort: 'high' },
      createdBy: null,
      autoApproveMode: 'off',
      autoMerge: false,
      mergeReady: false,
      mergeValue: null,
      blockedBy: [],
      blockedSeedMessage: null,
    });
  });

  it('nests thread groups → threads → review children + tasks (the full pipeline read shape)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'full pipeline',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Foundation',
    });
    // Two builder legs side by side (as a rotation would leave them) — both are thread group roots.
    const leg1 = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Foundation — leg 1',
    });
    const leg2 = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Foundation — leg 2',
    });
    await store.materializeReviewChildren(
      { id: leg2.id, jobId: job.id, orgId: ORG_ID },
      [
        {
          kind: 'review_agent',
          brief: 'BP',
          config: { lensId: 'best_practices' },
        },
        { kind: 'review_agent', brief: 'C', config: { lensId: 'correctness' } },
        { kind: 'review_fix', brief: 'fixes', config: {} },
      ],
    );
    await store.createTask({
      threadGroupId: threadGroup.id,
      orgId: ORG_ID,
      title: 'Write the migration',
    });
    await store.createTask({
      threadGroupId: threadGroup.id,
      orgId: ORG_ID,
      title: 'Wire the handler',
    });

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      threadGroups: Array<{
        kind: string;
        title: string | null;
        ordinal: number;
        threads: Array<{
          id: string;
          role: string;
          children: Array<{ role: string }>;
        }>;
        tasks: Array<{ subject: string }>;
      }>;
    };

    expect(state.threadGroups).toHaveLength(1);
    const [stg] = state.threadGroups;
    expect(stg.kind).toBe('build');
    expect(stg.title).toBe('Foundation');
    expect(typeof stg.ordinal).toBe('number');

    // Only the two builders are thread group roots — the review children nest under their own parent, not the thread group.
    expect(stg.threads).toHaveLength(2);
    const byId = new Map(stg.threads.map((t) => [t.id, t]));
    expect(
      byId
        .get(leg2.id)!
        .children.map((c) => c.role)
        .sort(),
    ).toEqual(['review_agent', 'review_agent', 'review_fix']);
    // Children attach only to their OWN parent — leg 1 has none.
    expect(byId.get(leg1.id)!.children).toEqual([]);

    expect(stg.tasks.map((t) => t.subject)).toEqual([
      'Write the migration',
      'Wire the handler',
    ]);
  });

  // ── ADR 0004 Phase 3 — halt-wake + bounded-fix store methods (live CAS correctness) ──────────────

  async function seedJobThread(): Promise<{
    jobId: string;
    threadGroupId: string;
    threadId: string;
  }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'halt',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — halt',
    });
    await store.setThreadStatus(thread.id, 'executing');
    return { jobId: job.id, threadGroupId: threadGroup.id, threadId: thread.id };
  }

  it('setHaltOwed → threadsAwaitingHaltWake selects it; markHaltWaked (matching gen) dedups it', async () => {
    const { jobId, threadId } = await seedJobThread();
    // A fresh thread is not owed a wake.
    expect(await store.threadsAwaitingHaltWake(jobId)).toEqual([]);

    await store.setHaltOwed(threadId, 'blocked');
    const owed = await store.threadsAwaitingHaltWake(jobId);
    expect(owed).toEqual([{ jobId, threadId, gen: 0, outcome: 'blocked' }]);

    // Stamp with the correct generation → deduped (no longer owed).
    await store.markHaltWaked(threadId, 0);
    expect(await store.threadsAwaitingHaltWake(jobId)).toEqual([]);
  });

  it('markHaltWaked with a STALE gen no-ops (a re-drive that bumped halt_fix_attempts wins the race)', async () => {
    const { jobId, threadId } = await seedJobThread();
    await store.setHaltOwed(threadId, 'blocked');
    // Simulate a re-drive claiming a fix attempt DURING the wake (gen 0 → 1) then re-arming the halt.
    const claim = await store.claimHaltFixAttempt(threadId, 2);
    expect(claim).toEqual({ ok: true, used: 1 });
    await store.clearHalt(threadId); // re-drive clears the halt…
    await store.setHaltOwed(threadId, 'blocked'); // …and it re-blocks, re-arming a fresh wake

    // The OLD wake (captured gen 0) now completes and stamps — must NO-OP (gen is 1 now), so the fresh
    // halt stays owed and its own wake will still fire.
    await store.markHaltWaked(threadId, 0);
    const owed = await store.threadsAwaitingHaltWake(jobId);
    expect(owed).toEqual([{ jobId, threadId, gen: 1, outcome: 'blocked' }]);
  });

  it('claimHaltFixAttempt is a CAS bounded by the cap (increments up to cap, then refuses)', async () => {
    const { threadId } = await seedJobThread();
    expect(await store.claimHaltFixAttempt(threadId, 2)).toEqual({
      ok: true,
      used: 1,
    });
    expect(await store.claimHaltFixAttempt(threadId, 2)).toEqual({
      ok: true,
      used: 2,
    });
    // At the cap → refused, budget unchanged.
    expect(await store.claimHaltFixAttempt(threadId, 2)).toEqual({
      ok: false,
      used: 2,
    });
  });

  it('two concurrent claims at the cap boundary — exactly one succeeds (row-level CAS)', async () => {
    const { threadId } = await seedJobThread();
    await store.claimHaltFixAttempt(threadId, 2); // used → 1
    // Two racing claims with cap 2: only one may take the last slot (used 1 → 2).
    const [a, b] = await Promise.all([
      store.claimHaltFixAttempt(threadId, 2),
      store.claimHaltFixAttempt(threadId, 2),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(oks[0]).toEqual({ ok: true, used: 2 });
  });

  // ── Decision d1 — completion-wake store methods (mirrors the halt trio, WITH a generation CAS) ─────

  it('setDoneWakeOwed → threadsAwaitingDoneWake selects only owed+un-waked rows', async () => {
    const { jobId, threadGroupId, threadId } = await seedJobThread();
    // A second thread on the SAME job, already waked — must never resurface as owed.
    const otherThread = await store.createThreadInThreadGroup({
      threadGroupId,
      jobId,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Frontend — done',
    });
    await store.setThreadStatus(otherThread.id, 'done');
    expect(await store.threadsAwaitingDoneWake(jobId)).toEqual([]);

    await store.setDoneWakeOwed(threadId, 'notable');
    await store.setDoneWakeOwed(otherThread.id, 'final');
    const g = await store.claimDoneWakeGen(otherThread.id);
    await store.markDoneWaked(otherThread.id, g!); // already waked — must be excluded

    const owed = await store.threadsAwaitingDoneWake(jobId);
    expect(owed).toEqual([{ jobId, threadId, reason: 'notable' }]);
  });

  it('claimDoneWakeGen bumps monotonically while owed, and returns null once not owed', async () => {
    const { threadId } = await seedJobThread();
    // Not owed yet → nothing to claim.
    expect(await store.claimDoneWakeGen(threadId)).toBeNull();

    await store.setDoneWakeOwed(threadId, 'final');
    expect(await store.claimDoneWakeGen(threadId)).toBe(1);
    expect(await store.claimDoneWakeGen(threadId)).toBe(2); // a re-delivery attempt gets a fresh gen

    // Once stamped (with the current gen) the wake is no longer owed → further claims are null.
    await store.markDoneWaked(threadId, 2);
    expect(await store.claimDoneWakeGen(threadId)).toBeNull();
  });

  it('markDoneWaked is a GENERATION-KEYED CAS — a stale gen is a no-op, only the current gen stamps', async () => {
    const { jobId, threadId } = await seedJobThread();
    await store.setDoneWakeOwed(threadId, 'final');
    const gen1 = await store.claimDoneWakeGen(threadId); // 1
    const gen2 = await store.claimDoneWakeGen(threadId); // 2 (a newer attempt superseded gen1)

    // The stale gen-1 attempt completing late must NOT clear the owed flag out from under gen 2.
    await store.markDoneWaked(threadId, gen1!);
    expect(await store.threadsAwaitingDoneWake(jobId)).toEqual([
      { jobId, threadId, reason: 'final' },
    ]);
    let row = await threads.findOne({ where: { id: threadId } });
    expect(row?.done_waked_at).toBeNull();

    // The live gen-2 attempt stamps it.
    await store.markDoneWaked(threadId, gen2!);
    expect(await store.threadsAwaitingDoneWake(jobId)).toEqual([]);
    row = await threads.findOne({ where: { id: threadId } });
    expect(row?.done_wake_owed).toBe(false);
    expect(row?.done_waked_at).toBeInstanceOf(Date);
  });

  it("supersedeDoneWakeMessages deletes only THIS thread's below-gen rows — spares other threads and untagged rows", async () => {
    const { jobId, threadGroupId, threadId } = await seedJobThread();
    const otherThread = await store.createThreadInThreadGroup({
      threadGroupId,
      jobId,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Other lane',
    });
    await store.setThreadStatus(otherThread.id, 'done');
    const mk = async (meta: Record<string, unknown> | null, text: string) =>
      (
        await messages.save(
          messages.create({
            job_id: jobId,
            thread_id: threadId,
            author: 'Atlas',
            author_id: 'atlas',
            text,
            kind: 'chat',
            meta,
          }),
        )
      ).id;

    const stalePartial = await mk(
      { doneWakeThreadId: threadId, doneWakeGen: 1 },
      'truncated gen-1 partial',
    );
    const currentSummary = await mk(
      { doneWakeThreadId: threadId, doneWakeGen: 2 },
      'complete gen-2 summary',
    );
    const otherThreadSummary = await mk(
      { doneWakeThreadId: otherThread.id, doneWakeGen: 1 },
      'other thread gen-1 summary',
    );
    const untagged = await mk(null, 'normal operator chat');

    // Deliver gen 2 for `threadId` → supersede its gen<2 rows only.
    await store.supersedeDoneWakeMessages(jobId, threadId, 2);

    const survivors = (await messages.find({ where: { job_id: jobId } })).map(
      (m) => m.id,
    );
    expect(survivors).not.toContain(stalePartial); // the truncated gen-1 partial is gone
    expect(survivors).toEqual(
      expect.arrayContaining([currentSummary, otherThreadSummary, untagged]),
    );
  });

  it("masterReviewThreadId returns the job's master_review thread id, or null when it has none", async () => {
    const { jobId } = await seedJobThread();
    expect(await store.masterReviewThreadId(jobId)).toBeNull();

    // master_review is a singleton thread group kind — give it its own thread group.
    const masterThreadGroup = await store.createThreadGroup({
      jobId,
      orgId: ORG_ID,
      kind: 'master_review',
    });
    const masterReview = await store.createThreadInThreadGroup({
      threadGroupId: masterThreadGroup.id,
      jobId,
      orgId: ORG_ID,
      role: 'master_review',
      // A distinct ordinal from the seed builder — `uq_threads_job_parent_ordinal` is UNIQUE
      // (job_id, parent_thread_id, ordinal) NULLS NOT DISTINCT, so two root threads on the same job
      // can't share an ordinal even across thread groups.
      ordinal: 20,
      brief: 'master review',
    });
    await store.setThreadStatus(masterReview.id, 'executing');
    expect(await store.masterReviewThreadId(jobId)).toBe(masterReview.id);
  });

  // ── Leg rotation (context-rot: one build thread group → many sequential builder-thread legs) ──────────────

  async function seedRotationThread(sessionId: string | null): Promise<{
    jobId: string;
    threadGroupId: string;
    threadId: string;
  }> {
    const seeded = await seedJobThread();
    if (sessionId)
      await threads.update({ id: seeded.threadId }, { session_id: sessionId });
    return seeded;
  }

  it('completeLegRotation inserts the next builder leg, stashes the seed, and leaves the old row untouched', async () => {
    const { threadGroupId, threadId } = await seedRotationThread('sess-1');

    const res = await store.completeLegRotation({
      anchorStepId: threadId,
      handoff: 'HANDOFF BODY',
      seed: 'SEED PREAMBLE + HANDOFF BODY',
      contextTokensPeak: 210_000,
    });
    expect(res).toEqual({ fromLeg: 1, toLeg: 2, abandonedSessionId: 'sess-1' });

    // Rotation INSERTS the next builder leg; the OLD row is untouched (its session is NOT nulled — a
    // rotation must never look like a committed batch that mutated the current leg).
    const rows = await store.threadsForThreadGroup(threadGroupId);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(threadId);
    expect(rows[0].session_id).toBe('sess-1');

    const next = rows[1];
    expect(next.role).toBe('builder');
    expect(next.session_id).toBeNull(); // fresh start next turn
    expect(next.handoff_in).toBe('HANDOFF BODY');
    expect((next.config as { pendingLegSeed?: string }).pendingLegSeed).toBe(
      'SEED PREAMBLE + HANDOFF BODY',
    );
    expect(next.status).toBe('pending');

    // The seed reads back off the NEW row for the driver-side fold.
    expect(await store.getPendingLegSeed(next.id)).toBe(
      'SEED PREAMBLE + HANDOFF BODY',
    );
  });

  it('completeLegRotation allocates a JOB-UNIQUE ordinal, so a rotation in one thread group of a multi-thread-group job never collides with a sibling thread group (regression)', async () => {
    // The rotating builder is at ordinal 10 in its own build thread group. A thread-group-LOCAL allocation (the bug) would
    // pick `max(thread group siblings)+GAP = 20`. But `uq_threads_job_parent_ordinal` is UNIQUE(job_id,
    // parent_thread_id, ordinal) NULLS NOT DISTINCT — JOB-global — and a SIBLING build thread group in the SAME job
    // already occupies ordinal 20 (both root threads, parent_thread_id null). Pre-fix, the INSERT hit the
    // unique index, the txn threw, and rotation silently failed ("handoff rotation isn't working").
    const { jobId, threadGroupId, threadId } = await seedRotationThread('sess-1');
    const siblingThreadGroup = await store.createThreadGroup({
      jobId,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Frontend',
    });
    await store.createThreadInThreadGroup({
      threadGroupId: siblingThreadGroup.id,
      jobId,
      orgId: ORG_ID,
      role: 'builder',
      ordinal: 20, // the ordinal a thread-group-local allocation would (wrongly) reuse for the new leg
      brief: 'Frontend',
    });

    // With the fix this resolves (no unique violation); pre-fix it REJECTED here.
    const res = await store.completeLegRotation({
      anchorStepId: threadId,
      handoff: 'H',
      seed: 'S',
    });
    expect(res).toEqual({ fromLeg: 1, toLeg: 2, abandonedSessionId: 'sess-1' });

    // The new leg lands in the ROTATING thread's thread group, at a job-unique ordinal past the sibling's 20.
    const rows = await store.threadsForThreadGroup(threadGroupId);
    expect(rows).toHaveLength(2);
    const leg2 = rows[1];
    expect(leg2.role).toBe('builder');
    expect(leg2.handoff_in).toBe('H');
    expect(leg2.ordinal).toBeGreaterThan(20);
  });

  it('completeLegRotation is a no-op (returns null) when there is no live session to rotate', async () => {
    const { threadGroupId, threadId } = await seedRotationThread(null);
    const res = await store.completeLegRotation({
      anchorStepId: threadId,
      handoff: 'x',
      seed: 'y',
    });
    expect(res).toBeNull();
    // Nothing inserted — the lone builder leg is unchanged.
    expect(await store.threadsForThreadGroup(threadGroupId)).toHaveLength(1);
  });

  it('recordActiveLeg records the live session and keeps the PEAK context occupancy', async () => {
    const { threadId } = await seedRotationThread('sess-1');
    await store.recordActiveLeg(threadId, 'sess-1', 120_000);
    await store.recordActiveLeg(threadId, 'sess-1', 90_000); // lower sample must NOT lower the peak
    const row = await threads.findOne({ where: { id: threadId } });
    expect(row?.session_id).toBe('sess-1');
    expect(
      (row?.config as { contextTokensPeak?: number }).contextTokensPeak,
    ).toBe(120_000);
  });

  // ── Transcript anchor (the halt-wake's session pointer) ────────────────────────────────────────────

  it("resolveSessionAnchor returns the thread's session id + its builder-leg ordinal (no terminal record needed)", async () => {
    const { threadGroupId, threadId } = await seedRotationThread('sess-1');

    // A lone builder leg resolves to legOrdinal 1, straight off its own session — no terminal record needed.
    expect(await store.getTerminalRecord(threadId)).toBeNull();
    expect(await store.resolveSessionAnchor(threadId)).toEqual({
      sessionId: 'sess-1',
      legOrdinal: 1,
    });

    // Rotate to leg 2, give it its own session → the anchor resolves to that leg's ordinal + session.
    await store.completeLegRotation({
      anchorStepId: threadId,
      handoff: 'h',
      seed: 's',
    });
    const leg2 = (await store.threadsForThreadGroup(threadGroupId))[1];
    await threads.update({ id: leg2.id }, { session_id: 'sess-2' });
    expect(await store.resolveSessionAnchor(leg2.id)).toEqual({
      sessionId: 'sess-2',
      legOrdinal: 2,
    });
  });

  it('resolveSessionAnchor is undefined when the thread never got a session', async () => {
    const { threadId } = await seedRotationThread(null);
    expect(await store.resolveSessionAnchor(threadId)).toBeUndefined();
  });

  // ── Regression: the prod `get_pipeline_state` "empty Error" incident (missing `AddJobHalt` migration) ──

  // Regression tripwire for the prod `get_pipeline_state` "empty Error" incident: the handler reads the
  // `halt` column added by the `AddJobHalt` migration (job.status split). This asserts the read model maps
  // it AND doubles as a guard that the test DB is migrated. (The prod cause — a DB missing this column — is
  // NOT reproduced here: dropping a column on the shared, parallel `_test` DB breaks other suites; the
  // never-empty error-serialization that surfaces such a throw is covered by tool-bridge-host.spec.ts.)
  it('maps the nullable `halt` column (tripwire: the test DB is migrated for the job.status split)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'halt tripwire',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      halt: unknown;
    };
    expect(state.halt).toBeNull();
  });

  // ── retractShip (the ship-review gate's retract CAS + card neutralization) ───────────────────────

  async function seedShipParkedJob(): Promise<{
    jobId: string;
    threadId: string;
  }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'ship-parked',
        kind: 'feature',
        status: 'awaiting_ship_review',
        activity: 'idle',
        base_branch: BASE_BRANCH,
      }),
    );
    // A card row's `thread_id` is NOT NULL (d3) — seed a thread to anchor the durable ship card on.
    const threadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'planning',
    });
    const thread = await store.createThreadInThreadGroup({
      threadGroupId: threadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'main',
      brief: 'ship',
    });
    return { jobId: job.id, threadId: thread.id };
  }

  async function seedShipCardRow(
    jobId: string,
    threadId: string,
  ): Promise<void> {
    const card = webShipReviewCard({
      jobId,
      title: 'Ready to ship',
      summary: 'The build is ready.',
    });
    await messages.save(
      messages.create({
        job_id: jobId,
        thread_id: threadId,
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: 'Ready to ship',
        kind: 'card',
        ts: `ship-review:${jobId}`,
        card: card as unknown as Record<string, unknown>,
      }),
    );
  }

  it('retractShip flips awaiting_ship_review -> amending and neutralizes the durable ship card', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    await seedShipCardRow(jobId, threadId);

    const acted = await store.retractShip(jobId);
    expect(acted).toBe(true);

    const row = await jobs.findOne({ where: { id: jobId } });
    expect(row?.status).toBe('amending');
    expect(row?.activity).toBe('idle');
    expect(row?.ship_review_approved_at).toBeNull();

    const cardRow = await messages.findOne({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    expect(cardRow?.card).toMatchObject({ type: 'verdict_card' });
    expect(
      (cardRow?.card as Record<string, unknown> | undefined)?.actions,
    ).toBeUndefined();
  });

  it('a second retractShip call is a no-op (idempotent, returns false)', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    await seedShipCardRow(jobId, threadId);

    expect(await store.retractShip(jobId)).toBe(true);
    expect(await store.retractShip(jobId)).toBe(false);

    const row = await jobs.findOne({ where: { id: jobId } });
    expect(row?.status).toBe('amending'); // unchanged by the no-op second call
  });

  it('parkForShipReview re-parks an amending job -> awaiting_ship_review + re-posts the ship card (amend re-arm)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'amending-job',
        kind: 'feature',
        status: 'amending',
        activity: 'idle',
        base_branch: BASE_BRANCH,
      }),
    );
    // parkForShipReview anchors its ship card on the job's planning thread (messages.thread_id is NOT
    // NULL) — every job gets exactly one at job start (d7); seed it directly here.
    const planningThreadGroup = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'planning',
    });
    await store.createThreadInThreadGroup({
      threadGroupId: planningThreadGroup.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'planning',
      brief: 'Main',
    });
    const card = webShipReviewCard({
      jobId: job.id,
      title: 'amending-job',
      summary: 'Amend verified.',
    });
    const parked = await store.parkForShipReview(
      job.id,
      card as unknown as Record<string, unknown>,
      'Amend verified.',
    );
    expect(parked).toBe(true);

    const row = await jobs.findOne({ where: { id: job.id } });
    expect(row?.status).toBe('awaiting_ship_review');
    expect(row?.activity).toBe('idle');

    const cardRow = await messages.findOne({
      where: { job_id: job.id, ts: `ship-review:${job.id}`, kind: 'card' },
    });
    expect(cardRow).toBeTruthy();
  });

  it('retractShip does not act on a job in a DIFFERENT status', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'running job',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );

    expect(await store.retractShip(job.id)).toBe(false);
    const row = await jobs.findOne({ where: { id: job.id } });
    expect(row?.status).toBe('running'); // untouched
  });

  it('neutralizes EVERY ship-review card row across a re-arm cycle (no unique (job_id,ts,kind) constraint)', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    // Two rows with the SAME ts (simulating a re-arm: park → retract → park again inserted a second row).
    await seedShipCardRow(jobId, threadId);
    await seedShipCardRow(jobId, threadId);

    const acted = await store.retractShip(jobId);
    expect(acted).toBe(true);

    const rows = await messages.find({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.card).toMatchObject({ type: 'verdict_card' });
      expect(
        (row.card as Record<string, unknown> | null)?.actions,
      ).toBeUndefined();
    }
  });

  // ── markPreviewRequested (the "Spin up preview" ship-card stamp CAS) ──────────────────────────────

  it('markPreviewRequested stamps the active ship card previewRequestedAt (first click wins)', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    await seedShipCardRow(jobId, threadId);

    const stamped = await store.markPreviewRequested(jobId);
    expect(stamped).toBe(true);

    const cardRow = await messages.findOne({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    const card = cardRow?.card as Record<string, unknown> | undefined;
    expect(card?.type).toBe('approval_card');
    expect(card?.kind).toBe('ship');
    expect(typeof card?.previewRequestedAt).toBe('string');
  });

  it('a second markPreviewRequested is a no-op (idempotent double-click, returns false)', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    await seedShipCardRow(jobId, threadId);

    expect(await store.markPreviewRequested(jobId)).toBe(true);
    const cardRow = await messages.findOne({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    const firstStamp = (cardRow?.card as Record<string, unknown> | undefined)
      ?.previewRequestedAt;

    expect(await store.markPreviewRequested(jobId)).toBe(false);
    const cardRow2 = await messages.findOne({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    // The stamp is unchanged — the losing call did not re-stamp.
    expect(
      (cardRow2?.card as Record<string, unknown> | undefined)
        ?.previewRequestedAt,
    ).toBe(firstStamp);
  });

  it('markPreviewRequested does NOT stamp a retracted (neutralized) ship card', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    await seedShipCardRow(jobId, threadId);
    // Retract neutralizes the card to a verdict_card — its type/kind guards must reject the stamp.
    expect(await store.retractShip(jobId)).toBe(true);

    expect(await store.markPreviewRequested(jobId)).toBe(false);
    const cardRow = await messages.findOne({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    expect(
      (cardRow?.card as Record<string, unknown> | undefined)
        ?.previewRequestedAt,
    ).toBeUndefined();
  });

  it('markPreviewRequested does NOT stamp when the job has left the ship gate', async () => {
    const { jobId, threadId } = await seedShipParkedJob();
    await seedShipCardRow(jobId, threadId);
    await jobs.update({ id: jobId }, { status: 'running' });

    expect(await store.markPreviewRequested(jobId)).toBe(false);
    const cardRow = await messages.findOne({
      where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
    });
    expect(
      (cardRow?.card as Record<string, unknown> | undefined)
        ?.previewRequestedAt,
    ).toBeUndefined();
  });

  // ── Retry-budget counters durability — auth_retry_attempts / driver_transient_retries (job-scoped, ─────
  // ── CAS against real Postgres so a restart/crash-loop can't re-grant a fresh budget) ────────────────

  async function seedBareJob(): Promise<{ jobId: string }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'retry counters',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    return { jobId: job.id };
  }

  it('runningJobs skips future retry parks so boot resume does not beat the cooldown clock', async () => {
    const ready = await seedBareJob();
    const due = await seedBareJob();
    const cooling = await seedBareJob();
    await store.setSessionResume(due.jobId, new Date(Date.now() - 1_000).toISOString(), {
      lane: 'build',
      reason: 'retry due',
      resetSource: 'usage_api',
      kind: 'retry',
    });
    await store.setSessionResume(cooling.jobId, new Date(Date.now() + 60_000).toISOString(), {
      lane: 'build',
      reason: 'retry cooling',
      resetSource: 'usage_api',
      kind: 'retry',
    });

    const ids = new Set((await store.runningJobs()).map((j) => j.id));

    expect(ids.has(ready.jobId)).toBe(true);
    expect(ids.has(due.jobId)).toBe(true);
    expect(ids.has(cooling.jobId)).toBe(false);
  });

  it('claimAuthRetryAttempt is a CAS bounded by the cap (increments up to cap, then refuses)', async () => {
    const { jobId } = await seedBareJob();
    expect(await store.claimAuthRetryAttempt(jobId, 2)).toEqual({ ok: true, used: 1 });
    expect(await store.claimAuthRetryAttempt(jobId, 2)).toEqual({ ok: true, used: 2 });
    // At the cap → refused, budget unchanged.
    expect(await store.claimAuthRetryAttempt(jobId, 2)).toEqual({ ok: false, used: 2 });
  });

  it('claimDriverTransientRetry is a CAS bounded by the cap (increments up to cap, then refuses)', async () => {
    const { jobId } = await seedBareJob();
    expect(await store.claimDriverTransientRetry(jobId, 2)).toEqual({ ok: true, used: 1 });
    expect(await store.claimDriverTransientRetry(jobId, 2)).toEqual({ ok: true, used: 2 });
    // At the cap → refused, budget unchanged.
    expect(await store.claimDriverTransientRetry(jobId, 2)).toEqual({ ok: false, used: 2 });
  });

  it('claimSessionLimitTextMisfire is a CAS bounded by the cap (increments up to cap, then refuses)', async () => {
    const { jobId } = await seedBareJob();
    expect(await store.claimSessionLimitTextMisfire(jobId, 3)).toEqual({ ok: true, used: 1 });
    expect(await store.claimSessionLimitTextMisfire(jobId, 3)).toEqual({ ok: true, used: 2 });
    expect(await store.claimSessionLimitTextMisfire(jobId, 3)).toEqual({ ok: true, used: 3 });
    // At the cap → refused, budget unchanged.
    expect(await store.claimSessionLimitTextMisfire(jobId, 3)).toEqual({ ok: false, used: 3 });
  });

  it('two concurrent claimSessionLimitTextMisfire calls at the cap boundary — exactly one succeeds (row-level CAS)', async () => {
    const { jobId } = await seedBareJob();
    await store.claimSessionLimitTextMisfire(jobId, 2); // used → 1
    // Two racing claims with cap 2: only one may take the last slot (used 1 → 2).
    const [a, b] = await Promise.all([
      store.claimSessionLimitTextMisfire(jobId, 2),
      store.claimSessionLimitTextMisfire(jobId, 2),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(oks[0]).toEqual({ ok: true, used: 2 });
  });

  it('claimAuthRetryAttempt and claimDriverTransientRetry both stamp retry_last_attempt_at', async () => {
    const { jobId } = await seedBareJob();
    const before = Date.now();
    expect(await store.claimAuthRetryAttempt(jobId, 5)).toEqual({ ok: true, used: 1 });
    let row = await jobs.findOne({ where: { id: jobId } });
    expect(row?.retry_last_attempt_at).toBeInstanceOf(Date);
    expect(row!.retry_last_attempt_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(await store.claimDriverTransientRetry(jobId, 5)).toEqual({ ok: true, used: 1 });
    row = await jobs.findOne({ where: { id: jobId } });
    expect(row?.retry_last_attempt_at).toBeInstanceOf(Date);
    expect(row!.retry_last_attempt_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('two concurrent claimDriverTransientRetry calls at the cap boundary — exactly one succeeds (row-level CAS)', async () => {
    const { jobId } = await seedBareJob();
    await store.claimDriverTransientRetry(jobId, 2); // used → 1
    // Two racing claims with cap 2: only one may take the last slot (used 1 → 2).
    const [a, b] = await Promise.all([
      store.claimDriverTransientRetry(jobId, 2),
      store.claimDriverTransientRetry(jobId, 2),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(oks[0]).toEqual({ ok: true, used: 2 });
  });

  it('clearDriverRetryCounters zeroes only the driver lanes — leaves retry_last_attempt_at and the brain\'s lanes untouched', async () => {
    const { jobId } = await seedBareJob();
    await store.claimAuthRetryAttempt(jobId, 5);
    await store.claimDriverTransientRetry(jobId, 5);
    await store.claimSessionLimitTextMisfire(jobId, 5);
    // Bump the brain's own lane columns directly (no BrainStoreService in scope here) to prove
    // clearDriverRetryCounters doesn't reach across lanes.
    await jobs.update(
      { id: jobId },
      { benign_abort_redrives: 3, transient_retry_redrives: 4 },
    );
    const before = await jobs.findOne({ where: { id: jobId } });
    const stampBefore = before!.retry_last_attempt_at;
    expect(stampBefore).toBeInstanceOf(Date);

    await store.clearDriverRetryCounters(jobId);

    const after = await jobs.findOne({ where: { id: jobId } });
    expect(after?.auth_retry_attempts).toBe(0);
    expect(after?.driver_transient_retries).toBe(0);
    expect(after?.session_limit_text_misfires).toBe(0);
    // Untouched by the driver-lane clear.
    expect(after?.retry_last_attempt_at).toEqual(stampBefore);
    expect(after?.benign_abort_redrives).toBe(3);
    expect(after?.transient_retry_redrives).toBe(4);
  });

  it('driverTransientRetryState reads back the count + last-attempt timestamp (null/0 on a fresh job)', async () => {
    const { jobId } = await seedBareJob();
    expect(await store.driverTransientRetryState(jobId)).toEqual({
      count: 0,
      lastAttemptAt: null,
    });

    await store.claimDriverTransientRetry(jobId, 5);
    await store.claimDriverTransientRetry(jobId, 5);
    const state = await store.driverTransientRetryState(jobId);
    expect(state.count).toBe(2);
    expect(state.lastAttemptAt).toBeInstanceOf(Date);
  });
});
