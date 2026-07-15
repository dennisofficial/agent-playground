/**
 * Backend — recovery mechanics (judge_unavailable patient auto-retry + operator escape hatch).
 *
 * Proves — against LIVE Postgres (atlas_test) — the DB-dependent core of commit 45671fd5:
 *
 *   1. The web-console read-model wire fields the "Retry now" / "Skip & accept" buttons gate on
 *      (`blockReason`, `acceptableOnJudgeOutage`), mapped by `getPipelineState` from the thread's
 *      `terminal_record` jsonb — including the d4 safety split (accept offered ONLY when the LIVE judge
 *      was down AND static build+tests already passed).
 *   2. The jsonb round-trip + halt CAS/rearm primitives the recovery loop is built on:
 *      `recordThreadTermination`/`getTerminalRecord` (the no-migration `acceptRequested` marker survives),
 *      `claimHaltFixAttempt` bounded by `JUDGE_UNAVAILABLE_REDRIVE_CAP` (=20), `rearmHaltedThreads`
 *      (what "Retry now" calls), and `setJobHalt('incomplete', …)` (the backstop rest that lights the
 *      classic operator recovery surface).
 *
 * Modeled EXACTLY on driver-store.int.test.ts (same TypeOrm bootstrap, dbOpts(), DB_CONNECTION, naming
 * strategy, org/repo seeding, TRUNCATE-in-beforeEach). Real Postgres, no fakes — the store only touches
 * repositories.
 *
 * SCOPE (honest): the two POST endpoints (retry-verification / accept) are thin passthroughs to these
 * driver/store methods and are unit-covered in web-surface.controller.spec.ts; the full accept→done live
 * path runs `finalizeAcceptedThread`'s git ops which need a real sandbox worktree (unit-covered with
 * mocked git). This int test validates the DB-dependent core against real Postgres.
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
import type { ThreadTerminalRecord } from '../persistence/entities/thread.entity';
import { JobDependencyService } from '../job-deps';
import { JUDGE_UNAVAILABLE_REDRIVE_CAP } from '../domain';
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

/** The wedged prod row 0d029126: a done builder that HELD because the LIVE judge was unreachable. */
function judgeUnavailableRecord(
  staticChecksAdequate: boolean,
): ThreadTerminalRecord {
  return {
    status: 'blocked',
    summary:
      'Backend recovery mechanics — work complete, held on judge outage.',
    blocked: {
      reason: 'judge_unavailable',
      detail: 'the live-verification judge is temporarily unavailable',
    },
    staticVerification: {
      verdict: {
        staticChecksAdequate,
        reason: staticChecksAdequate
          ? 'typecheck + unit tests passed'
          : 'the static-check judge was itself unreachable',
      },
    },
  };
}

describe('Recovery mechanics — judge_unavailable read model + halt CAS (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: DriverStoreService;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
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

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Recovery Mechanics Org', 'recovery-mechanics-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'recovery-mechanics-repo', 'Recovery Mechanics Repo', 'https://github.com/x/y.git', $2, NULL, true)
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
      'TRUNCATE tasks, threads, stages, jobs RESTART IDENTITY CASCADE',
    );
  });

  async function seedJob(): Promise<JobEntity> {
    return jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'Backend — recovery mechanics',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
  }

  /**
   * Seeds a single stage-owned thread (every thread now requires a non-null `stage_id`). Columns the store's
   * create surface doesn't take (status/condition/terminal_record/halt_fix_attempts) are stamped directly so
   * the tests can reproduce the exact wedged-row shapes.
   */
  async function seedThread(
    jobId: string,
    opts: {
      role?: string;
      ordinal: number;
      brief: string;
      status?: string;
      condition?: string;
      config?: Record<string, unknown>;
      terminalRecord?: ThreadTerminalRecord | null;
      haltFixAttempts?: number;
    },
  ): Promise<ThreadEntity> {
    const stage = await store.createStage({
      jobId,
      orgId: ORG_ID,
      kind: 'build',
    });
    const thread = await store.createThreadInStage({
      stageId: stage.id,
      jobId,
      orgId: ORG_ID,
      role: opts.role ?? 'builder',
      brief: opts.brief,
      ordinal: opts.ordinal,
      config: opts.config,
    });
    const patch = {
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.condition !== undefined ? { condition: opts.condition } : {}),
      ...(opts.terminalRecord !== undefined
        ? { terminal_record: opts.terminalRecord }
        : {}),
      ...(opts.haltFixAttempts !== undefined
        ? { halt_fix_attempts: opts.haltFixAttempts }
        : {}),
    };
    if (Object.keys(patch).length)
      await threads.update({ id: thread.id }, patch);
    return threads.findOneOrFail({ where: { id: thread.id } });
  }

  // ── 1. Read-model wire fields — the exact payload the web console gates the recovery buttons on ─────

  it('maps blockReason + acceptableOnJudgeOutage from terminal_record jsonb (d4 accept-safety split)', async () => {
    const job = await seedJob();

    // Thread A — mirrors wedged prod row 0d029126: LIVE judge was down, static build+tests PASSED.
    const acceptable = await seedThread(job.id, {
      role: 'builder',
      ordinal: 10,
      brief: 'Backend — live judge down, static passed',
      status: 'executing',
      condition: 'paused',
      terminalRecord: judgeUnavailableRecord(true),
      haltFixAttempts: 20,
    });

    // Thread B — same block reason, but the STATIC judge was the one down → accept must NOT be offered.
    const notAcceptable = await seedThread(job.id, {
      role: 'builder',
      ordinal: 20,
      brief: 'Backend — static judge down, unverified',
      status: 'executing',
      condition: 'paused',
      terminalRecord: judgeUnavailableRecord(false),
      haltFixAttempts: 20,
    });

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      stages: Array<{
        threads: Array<{
          id: string;
          blockReason: string | null;
          acceptableOnJudgeOutage: boolean;
        }>;
      }>;
    };

    const byId = new Map(
      state.stages.flatMap((s) => s.threads).map((t) => [t.id, t]),
    );
    const a = byId.get(acceptable.id);
    const b = byId.get(notAcceptable.id);

    // Thread A: the "Skip & accept" button is offered (judge_unavailable + static checks adequate).
    expect(a?.blockReason).toBe('judge_unavailable');
    expect(a?.acceptableOnJudgeOutage).toBe(true);

    // Thread B: same hold reason surfaces, but accept is withheld — static verification did NOT pass.
    expect(b?.blockReason).toBe('judge_unavailable');
    expect(b?.acceptableOnJudgeOutage).toBe(false);
  });

  // ── 2. jsonb round-trip + halt CAS / rearm primitives the recovery loop is built on ─────────────────

  it('recordThreadTermination persists the acceptRequested jsonb marker (no-migration round-trip)', async () => {
    const job = await seedJob();
    const thread = await seedThread(job.id, {
      role: 'builder',
      ordinal: 10,
      brief: 'Backend — accept marker round-trip',
      status: 'executing',
    });

    const record: ThreadTerminalRecord = {
      ...judgeUnavailableRecord(true),
      acceptRequested: true,
    };
    await store.recordThreadTermination(thread.id, record);

    const readBack = await store.getTerminalRecord(thread.id);
    expect(readBack?.acceptRequested).toBe(true);
    expect(readBack?.blocked?.reason).toBe('judge_unavailable');
    expect(readBack?.staticVerification?.verdict?.staticChecksAdequate).toBe(
      true,
    );
  });

  it('setHaltBudgetReason persists the judge budget owner without clobbering other thread config', async () => {
    const job = await seedJob();
    const thread = await seedThread(job.id, {
      role: 'review_agent',
      ordinal: 10,
      brief: 'Backend — budget-owner marker',
      status: 'executing',
      config: {
        lensId: 'security',
        recovery: { keep: 'existing' },
      },
    });

    await store.setHaltBudgetReason(thread.id, 'judge_unavailable');

    expect(await store.haltBudgetReason(thread.id)).toBe('judge_unavailable');
    let readBack = await threads.findOneOrFail({ where: { id: thread.id } });
    expect(readBack.config).toEqual({
      lensId: 'security',
      recovery: { keep: 'existing', haltBudgetReason: 'judge_unavailable' },
    });

    await store.setHaltBudgetReason(thread.id, null);

    expect(await store.haltBudgetReason(thread.id)).toBeNull();
    readBack = await threads.findOneOrFail({ where: { id: thread.id } });
    expect(readBack.config).toEqual({
      lensId: 'security',
      recovery: { keep: 'existing' },
    });
  });

  it('claimHaltFixAttempt is a CAS bounded by JUDGE_UNAVAILABLE_REDRIVE_CAP (patient loop, then refuses)', async () => {
    expect(JUDGE_UNAVAILABLE_REDRIVE_CAP).toBe(20);

    const job = await seedJob();
    const thread = await seedThread(job.id, {
      role: 'builder',
      ordinal: 10,
      brief: 'Backend — judge redrive cap',
      status: 'executing',
    });

    // From halt_fix_attempts=0, the first claim succeeds and increments.
    expect(
      await store.claimHaltFixAttempt(thread.id, JUDGE_UNAVAILABLE_REDRIVE_CAP),
    ).toEqual({
      ok: true,
      used: 1,
    });
    expect(await store.haltFixAttempts(thread.id)).toBe(1);

    // Drive the budget to the cap (already used 1 above → 19 more claims land us at 20).
    for (let i = 2; i <= JUDGE_UNAVAILABLE_REDRIVE_CAP; i++) {
      expect(
        await store.claimHaltFixAttempt(
          thread.id,
          JUDGE_UNAVAILABLE_REDRIVE_CAP,
        ),
      ).toEqual({
        ok: true,
        used: i,
      });
    }
    expect(await store.haltFixAttempts(thread.id)).toBe(
      JUDGE_UNAVAILABLE_REDRIVE_CAP,
    );

    // At the cap → refused, budget unchanged (the patient loop stops and rests for the operator).
    expect(
      await store.claimHaltFixAttempt(thread.id, JUDGE_UNAVAILABLE_REDRIVE_CAP),
    ).toEqual({
      ok: false,
      used: JUDGE_UNAVAILABLE_REDRIVE_CAP,
    });
    expect(await store.haltFixAttempts(thread.id)).toBe(
      JUDGE_UNAVAILABLE_REDRIVE_CAP,
    );
  });

  it('rearmHaltedThreads resets halt_fix_attempts to 0 (what "Retry now" calls)', async () => {
    const job = await seedJob();
    const thread = await seedThread(job.id, {
      role: 'builder',
      ordinal: 10,
      brief: 'Backend — rearm',
      status: 'executing',
      condition: 'paused',
      haltFixAttempts: JUDGE_UNAVAILABLE_REDRIVE_CAP,
    });

    const rearmed = await store.rearmHaltedThreads(job.id);
    expect(rearmed).toBe(1);
    expect(await store.haltFixAttempts(thread.id)).toBe(0);

    // Idempotent: nothing left above 0 to re-arm.
    expect(await store.rearmHaltedThreads(job.id)).toBe(0);
  });

  it("setJobHalt('incomplete', …) rests the job on the classic operator recovery surface (backstop)", async () => {
    const job = await seedJob();
    const at = new Date().toISOString();

    await store.setJobHalt(job.id, {
      kind: 'incomplete',
      reason: 'judge_unavailable redrive budget exhausted',
      at,
    });

    const reloaded = await jobs.findOne({ where: { id: job.id } });
    expect(reloaded?.halt?.kind).toBe('incomplete');
    expect(reloaded?.halt?.reason).toBe(
      'judge_unavailable redrive budget exhausted',
    );
    expect(reloaded?.halt?.at).toBe(at);
    // The halt clears `activity` to idle so a stale phase can't mask it (deriveNeedsYou).
    expect(reloaded?.activity).toBe('idle');
  });
});
