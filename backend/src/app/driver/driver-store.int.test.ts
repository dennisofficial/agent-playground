/**
 * DriverStoreService.getPipelineState — the web `/pipeline` read model.
 *
 * Proves (against live Postgres) that the payload the operator console renders the navigator from now
 * carries the thread's STEPS (the execute folder's leaves) + the thread `hasPlan` flag, and the
 * thread's PR + branch on the job — the fields the thread-sidebar handoff added. Additive over the old
 * shape (id/ordinal/brief/status), so the brain's `get_pipeline_state` passthrough is unaffected.
 *
 * Integration: real Postgres (atlas_test schema), no fakes (the method only touches repositories).
 * Seeds an org/repo/thread + threads + steps directly, then asserts the mapped read model.
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
  StepEntity,
  ThreadEntity,
  JobEntity,
} from '../persistence/entities';
import { DriverStoreService } from './driver-store.service';

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
  let steps: Repository<StepEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [DriverStoreService],
    }).compile();

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
    steps = mod.get(getRepositoryToken(StepEntity, DB_CONNECTION));

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
    await ds.query('TRUNCATE steps, threads, jobs RESTART IDENTITY CASCADE');
  });

  it('returns steps + hasPlan per thread and the PR + branch on the job', async () => {
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
    const thread = await threads.save(
      threads.create({
        kind: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — wire the webhook handler',
        plan: 'detailed plan prose', // → hasPlan: true
        status: 'executing',
      }),
    );
    await steps.save([
      steps.create({
        thread_id: thread.id,
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        title: 'replay',
        brief: 'build replay',
        stage: 'build',
        status: 'building',
      }),
      steps.create({
        thread_id: thread.id,
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 20,
        title: 'sync',
        brief: 'build sync',
        stage: 'build',
        status: 'pending',
      }),
    ]);

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      status: string;
      prUrl: string | null;
      prNumber: number | null;
      featureBranch: string | null;
      baseBranch: string | null;
      threads: Array<{
        id: string;
        hasPlan: boolean;
        status: string;
        children: Array<{
          id: string;
          kind: string;
          status: string;
          lensId?: string;
          lane: string;
        }>;
        steps: Array<{
          ordinal: number;
          title: string | null;
          stage: string;
          status: string;
        }>;
      }>;
    };

    expect(state.status).toBe('running');
    expect(state.prUrl).toBe('https://github.com/x/y/pull/43');
    expect(state.prNumber).toBe(43);
    expect(state.featureBranch).toBe('atlas/feature-stripe');
    expect(state.baseBranch).toBe(BASE_BRANCH);

    expect(state.threads).toHaveLength(1);
    const [sec] = state.threads;
    expect(sec.hasPlan).toBe(true);
    // Review children are data-driven. With no materialized child rows yet (an un-reviewed / executing
    // builder), getPipelineState SYNTHESIZES the review set from the thread-kind registry so the rows + their
    // transcript lanes stay visible — the default lenses + the post-review fix, queued at `pending`.
    expect(
      sec.children.filter((c) => c.kind === 'review_lens').map((c) => c.lensId),
    ).toEqual(['best_practices', 'correctness', 'consistency', 'minimalism']);
    expect(sec.children.find((c) => c.kind === 'post_review')).toBeTruthy();
    expect(sec.children.every((c) => c.status === 'pending')).toBe(true);
    // Each synthesized child carries its real transcript lane (where the historical review turns live).
    expect(sec.children.find((c) => c.lensId === 'best_practices')?.lane).toBe(
      `autofix:${sec.id}:best_practices`,
    );
    expect(sec.steps.map((p) => p.title)).toEqual(['replay', 'sync']); // ordinal-sorted
    expect(sec.steps[0].status).toBe('building');
    expect(sec.steps[1].status).toBe('pending');
  });

  it('surfaces the committed `build_path` as `buildPath` — direct builds carry no lanes', async () => {
    // A DIRECT build: approved fast path, committed `build_path='direct'`, done, with NO builder threads.
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
      threads: unknown[];
    };
    expect(directState.buildPath).toBe('direct');
    expect(directState.threads).toHaveLength(0);

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
    const thread = await threads.save(
      threads.create({
        kind: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — review children',
        status: 'auto_fixing',
      }),
    );

    const childSpecs = [
      {
        kind: 'review_lens',
        brief: 'BP',
        config: { lensId: 'best_practices' },
      },
      { kind: 'review_lens', brief: 'C', config: { lensId: 'correctness' } },
      { kind: 'review_lens', brief: 'Cs', config: { lensId: 'consistency' } },
      {
        kind: 'post_review',
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

    const lenses = children.filter((c) => c.kind === 'review_lens');
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
      threads: Array<{
        children: Array<{
          id: string;
          kind: string;
          status: string;
          lensId?: string;
          findings: number | null;
          lane: string;
        }>;
      }>;
    };
    // The child rows are NOT top-level threads (they nest under their builder as `children`).
    expect(state.threads).toHaveLength(1);
    const lensRows = state.threads[0].children.filter(
      (c) => c.kind === 'review_lens',
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
    // Each lens carries its own streaming lane; the post_review child rides the fix lane.
    expect(byLens.get('best_practices')?.lane).toBe(
      `autofix:${thread.id}:best_practices`,
    );
    expect(
      state.threads[0].children.find((c) => c.kind === 'post_review')?.lane,
    ).toBe(`autofix:${thread.id}:fix`);

    // reviewChildren reads the full findings back off each lens row (post_review's source of truth).
    const fresh = await store.reviewChildren(thread.id);
    const bp = fresh.find(
      (c) => (c.config as { lensId?: string }).lensId === 'best_practices',
    );
    expect(bp?.reviewFindings).toHaveLength(1);
    expect(fresh.find((c) => c.kind === 'post_review')).toBeTruthy();
  });

  it('surfaces the per-thread LLM-authored task list, with NO fallback default (unlike review agents)', async () => {
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
    const thread = await threads.save(
      threads.create({
        kind: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — task list',
        status: 'executing',
      }),
    );

    // An un-touched thread: `tasks` is `[]` (no computed fallback — unlike reviewAgents, there's no
    // fixed/expected set for pure LLM output).
    const empty = (await store.getPipelineState(job.id, ORG_ID)) as {
      threads: Array<{ tasks: unknown[] }>;
    };
    expect(empty.threads[0].tasks).toEqual([]);

    // Simulate what the harness's fold does — a direct read-modify-write of the thread's jsonb column.
    await threads.update(
      { id: thread.id },
      {
        tasks: [
          { id: 't1', subject: 'Write the migration', status: 'in_progress' },
        ],
      },
    );

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      threads: Array<{
        tasks: Array<{ id: string; subject: string; status: string }>;
      }>;
    };
    expect(state.threads[0].tasks).toEqual([
      { id: 't1', subject: 'Write the migration', status: 'in_progress' },
    ]);
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
    const thread = await threads.save(
      threads.create({
        kind: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — orientation',
        status: 'planning',
      }),
    );

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
    // `no_job` still carries the brain's own task list + default footer — the navigator's Main row shows it
    // pre-plan, before the job has entered the build lifecycle.
    expect(await store.getPipelineState(job.id, ORG_ID)).toEqual({
      status: 'no_job',
      mainTasks: [],
      mainDefaultFooter: { engine: 'claude', model: 'opus' },
    });
  });

  // ── ADR 0004 Phase 3 — halt-wake + bounded-fix store methods (live CAS correctness) ──────────────

  async function seedJobThread(): Promise<{ jobId: string; threadId: string }> {
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
    const thread = await threads.save(
      threads.create({
        kind: 'builder',
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — halt',
        status: 'executing',
      }),
    );
    return { jobId: job.id, threadId: thread.id };
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

  // ── Leg rotation (context-rot: one build thread → many sequential engine sessions) ─────────────────

  async function seedJobThreadStep(
    sessionId: string | null,
  ): Promise<{ jobId: string; threadId: string; anchorStepId: string }> {
    const { jobId, threadId } = await seedJobThread();
    const step = await steps.save(
      steps.create({
        thread_id: threadId,
        job_id: jobId,
        org_id: ORG_ID,
        ordinal: 10,
        title: 'anchor',
        brief: 'build anchor',
        stage: 'build',
        status: 'building',
        batch_ordinal: 1,
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
    );
    return { jobId, threadId, anchorStepId: step.id };
  }

  it('completeLegRotation rotates the anchor session, stashes the seed, bumps leg_ordinal, projects Legs', async () => {
    const { threadId, anchorStepId } = await seedJobThreadStep('sess-1');

    const res = await store.completeLegRotation({
      anchorStepId,
      handoff: 'HANDOFF BODY',
      seed: 'SEED PREAMBLE + HANDOFF BODY',
      contextTokensPeak: 210_000,
    });
    expect(res).toEqual({ fromLeg: 1, toLeg: 2, abandonedSessionId: 'sess-1' });

    // The anchor step: session NULLed (fresh start next turn), abandon marker + seed set, leg bumped. The
    // atomic-resume markers are untouched — a rotation must never look like a committed batch.
    const step = await steps.findOne({ where: { id: anchorStepId } });
    expect(step?.session_id).toBeNull();
    expect(step?.rotating_session_id).toBe('sess-1');
    expect(step?.pending_leg_seed).toBe('SEED PREAMBLE + HANDOFF BODY');
    expect(step?.leg_ordinal).toBe(2);
    expect(step?.batch_ordinal).toBe(1); // untouched
    expect(step?.commit_sha).toBeNull(); // untouched

    // The seed reads back for the driver-side fold.
    expect(await store.getPendingLegSeed(anchorStepId)).toBe(
      'SEED PREAMBLE + HANDOFF BODY',
    );

    // The Leg projection: leg 1 closed (rotated + handoff + peak + ended_at), leg 2 opened (active).
    const legs = await store.getLegs(threadId);
    expect(legs.map((l) => l.ordinal)).toEqual([1, 2]);
    expect(legs[0]).toMatchObject({
      status: 'rotated',
      handoff_md: 'HANDOFF BODY',
      session_id: 'sess-1',
      context_tokens_peak: 210_000,
    });
    expect(legs[0].ended_at).toBeInstanceOf(Date);
    expect(legs[1]).toMatchObject({ status: 'active', session_id: null });
    expect(legs[1].ended_at).toBeNull();
  });

  it('completeLegRotation is a no-op (returns null) when there is no live session to rotate', async () => {
    const { threadId, anchorStepId } = await seedJobThreadStep(null);
    const res = await store.completeLegRotation({
      anchorStepId,
      handoff: 'x',
      seed: 'y',
    });
    expect(res).toBeNull();
    const step = await steps.findOne({ where: { id: anchorStepId } });
    expect(step?.leg_ordinal).toBe(1); // unchanged
    expect(step?.pending_leg_seed).toBeNull();
    expect(await store.getLegs(threadId)).toEqual([]);
  });

  it('recordActiveLeg upserts the current Leg row idempotently and keeps the PEAK occupancy', async () => {
    const { threadId, anchorStepId } = await seedJobThreadStep('sess-1');
    await store.recordActiveLeg(anchorStepId, 'sess-1', 120_000);
    await store.recordActiveLeg(anchorStepId, 'sess-1', 90_000); // lower sample must NOT lower the peak
    const legs = await store.getLegs(threadId);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      ordinal: 1,
      status: 'active',
      session_id: 'sess-1',
      context_tokens_peak: 120_000,
    });
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
    const state = (await store.getPipelineState(job.id, ORG_ID)) as { halt: unknown };
    expect(state.halt).toBeNull();
  });
});
