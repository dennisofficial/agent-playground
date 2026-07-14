import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlanReviewService,
  parsePlanFindings,
  serializeFindings,
  deserializeFindings,
  summarizeEngineError,
} from './plan-review.service';
import type { PlanReviewInput } from './plan-review.service';
import { BrainStoreService } from './brain-store.service';
import type { EngineRunnerPort, EngineRunResult } from '../engine/engine.types';
import type { JobLifecycleService } from '../driver/job-lifecycle.service';
import type { CredentialResolver } from '../onboarding';
import type { Repository } from 'typeorm';
import type { JobEntity, StageEntity, ThreadEntity } from '../persistence/entities';
import type { BlockSink, TurnHarnessFactory } from '../surface';
import type { JobDependencyService } from '../job-deps';

/** Creds stub: no per-org secret → the engine uses its env fallback (these tests stub the engine). */
const fakeCreds = {
  engineAuth: async () => undefined,
} as unknown as CredentialResolver;

/** Leader-election stub: not draining (default). */
const fakeElection = {
  isDraining: () => false,
} as unknown as import('../cluster').LeaderElectionService;

/**
 * The synchronous, Atlas-driven Codex review service:
 *   - parsePlanFindings extracts severity-tagged FINDING lines / recognises NO_FINDINGS.
 *   - serialize/deserialize round-trip findings for the durable row.
 *   - review() runs ONE Codex turn, persists the job's `plan_review` thread, resumes the session.
 *   - reviewForCurrentSpecs is the propose_plan mandatory-run gate (terminal + matching spec_hash).
 */

// ── parser + (de)serialize ─────────────────────────────────────────────────────────────────────

describe('parsePlanFindings', () => {
  it('extracts severity-tagged findings', () => {
    const out = parsePlanFindings(
      [
        'FINDING [BLOCKING]: schema gap — the mic flow needs user_uid (server.ts:12)',
        'FINDING [ADVISORY]: rename the helper for clarity',
        'some prose the reviewer added',
      ].join('\n'),
    );
    expect(out).toEqual([
      { severity: 'BLOCKING', text: 'schema gap — the mic flow needs user_uid (server.ts:12)' },
      { severity: 'ADVISORY', text: 'rename the helper for clarity' },
    ]);
  });

  it('returns [] on NO_FINDINGS (case-insensitive)', () => {
    expect(parsePlanFindings('no_findings')).toEqual([]);
    expect(parsePlanFindings('Everything looks good.\nNO_FINDINGS')).toEqual([]);
  });

  it('treats a bare untagged FINDING as BLOCKING (lenient back-compat)', () => {
    expect(parsePlanFindings('FINDING: something is off')).toEqual([
      { severity: 'BLOCKING', text: 'something is off' },
    ]);
  });

  it('round-trips through serialize/deserialize', () => {
    const findings = [
      { severity: 'BLOCKING' as const, text: 'a' },
      { severity: 'ADVISORY' as const, text: 'b' },
    ];
    expect(deserializeFindings(serializeFindings(findings))).toEqual(findings);
    expect(deserializeFindings(null)).toEqual([]);
    expect(deserializeFindings('')).toEqual([]);
  });
});

describe('summarizeEngineError', () => {
  it('pulls the embedded message and takes the first line', () => {
    expect(summarizeEngineError(new Error('boom\nsecond line'))).toBe('boom');
    expect(
      summarizeEngineError(new Error('{"error":{"message":"bad token"}}')),
    ).toBe('bad token');
  });
});

// ── review() + the gate ──────────────────────────────────────────────────────────────────────

/** The retired `codex_reviews` field names these fixtures still accept, translated onto the new
 *  `plan_review` thread's `config` (see `PlanReviewConfig`) — keeps each test's seed literal unchanged. */
type PlanReviewThreadSeed = {
  id?: string;
  job_id?: string;
  org_id?: string;
  resume_count?: number;
  status?: 'running' | 'complete' | 'failed';
  findings?: string | null;
  error?: string | null;
  codex_session_id?: string | null;
  spec_hash?: string | null;
  created_at?: Date;
  updated_at?: Date;
};

/** A minimal in-memory fake of `this.threads` (a job's `plan_review`-role thread rows) — the retired
 *  `codex_reviews` repo now folds onto `ThreadEntity.session_id` + `.config`. */
function fakePlanReviewThreadsRepo(seed: PlanReviewThreadSeed[] = []) {
  const rows = seed.map((r, i) => ({
    id: r.id ?? `thread-${i}`,
    job_id: r.job_id,
    org_id: r.org_id,
    stage_id: 'stage-1',
    role: 'plan_review',
    parent_thread_id: null,
    ordinal: 10,
    brief: 'Plan review',
    type: 'general',
    status: 'reviewing',
    condition: 'none',
    session_id: r.codex_session_id ?? null,
    config: {
      specHash: r.spec_hash ?? null,
      resumeCount: r.resume_count ?? 0,
      findings: r.findings ?? [],
      status: r.status ?? 'running',
      error: r.error ?? null,
    },
    created_at: r.created_at ?? new Date(2026, 0, 1, 0, i),
    updated_at: r.updated_at ?? new Date(2026, 0, 1, 0, i),
  })) as unknown as ThreadEntity[];

  const matches = (row: ThreadEntity, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => v == null || (row as unknown as Record<string, unknown>)[k] === v,
    );

  return {
    create: (r: Partial<ThreadEntity>) => ({ ...r }) as ThreadEntity,
    save: vi.fn(async (r: ThreadEntity) => {
      const existing = r.id ? rows.find((x) => x.id === r.id) : undefined;
      if (existing) {
        Object.assign(existing, r, { updated_at: new Date() });
        return existing;
      }
      const saved = {
        ...r,
        id: r.id ?? `thread-${rows.length}`,
        created_at: r.created_at ?? new Date(),
        updated_at: r.updated_at ?? new Date(),
      } as ThreadEntity;
      rows.push(saved);
      return saved;
    }),
    update: vi.fn(async (where: { id: string }, patch: Partial<ThreadEntity>) => {
      const row = rows.find((x) => x.id === where.id);
      if (row) Object.assign(row, patch, { updated_at: new Date() });
    }),
    findOne: vi.fn(
      async ({
        where,
        order,
      }: {
        where: Record<string, unknown>;
        order?: { created_at?: 'ASC' | 'DESC' };
      }) => {
        const found = rows.filter((r) => matches(r, where));
        if (order?.created_at === 'DESC') {
          found.sort((a, b) => +b.created_at - +a.created_at);
        }
        return found[0] ?? null;
      },
    ),
    findOneOrFail: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error('not found');
      return r;
    }),
    createQueryBuilder: () => {
      const params: Record<string, unknown> = {};
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'where', 'andWhere']) {
        qb[m] = (_cond?: unknown, p?: Record<string, unknown>) => {
          if (p) Object.assign(params, p);
          return qb;
        };
      }
      qb.getMany = async () =>
        rows.filter(
          (r) => r.role === 'plan_review' && (r.config as { status?: string })?.status === 'running',
        );
      qb.getRawOne = async () => {
        const jobId = params['jobId'] as string | undefined;
        const matching = rows.filter((r) => jobId == null || r.job_id === jobId);
        return { max: matching.reduce((m, r) => Math.max(m, r.ordinal ?? 0), 0) };
      };
      return qb;
    },
  } as unknown as Repository<ThreadEntity>;
}

/** A minimal in-memory fake of `this.stages` — auto-vivifies the job's single `plan_review` stage.
 *  No test asserts on the stage row itself; it just needs to resolve consistently. */
function fakeStagesRepo() {
  const rows: StageEntity[] = [];
  return {
    findOne: vi.fn(
      async ({ where }: { where: { job_id: string; kind: string } }) =>
        rows.find((s) => s.job_id === where.job_id && s.kind === where.kind) ?? null,
    ),
    create: (r: Partial<StageEntity>) => ({ ...r }) as StageEntity,
    save: vi.fn(async (r: StageEntity) => {
      const saved = { ...r, id: r.id ?? `stage-${rows.length + 1}` } as StageEntity;
      rows.push(saved);
      return saved;
    }),
    createQueryBuilder: () => {
      const params: Record<string, unknown> = {};
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'where', 'andWhere']) {
        qb[m] = (_cond?: unknown, p?: Record<string, unknown>) => {
          if (p) Object.assign(params, p);
          return qb;
        };
      }
      qb.getRawOne = async () => {
        const jobId = params['jobId'] as string | undefined;
        const matching = rows.filter((r) => jobId == null || r.job_id === jobId);
        return { max: matching.reduce((m, r) => Math.max(m, r.ordinal ?? 0), 0) };
      };
      return qb;
    },
  } as unknown as Repository<StageEntity>;
}

function makeService(opts: {
  threads: ReturnType<typeof fakePlanReviewThreadsRepo>;
  ensureContainer?: unknown;
  engineRun?: (args: unknown) => Promise<EngineRunResult>;
  contextDirHost?: string;
  /** Called when the harness `finish()` runs — lets a test observe reply-persist ordering. */
  onFinish?: () => void;
  /** Inject a capturing `jobs` repo to assert the `activity` axis writes. */
  jobs?: Repository<JobEntity>;
}) {
  const engine = {
    run: vi.fn(
      opts.engineRun ??
        (async () => ({ result: 'NO_FINDINGS', sessionId: 'sess-1' }) as EngineRunResult),
    ),
  } as unknown as EngineRunnerPort;
  const lifecycle = {
    ensureContainer: vi.fn(
      async () =>
        opts.ensureContainer === undefined
          ? { sandbox: { worktreePath: '/tmp/wt', containerId: 'c1' } }
          : opts.ensureContainer,
    ),
    contextDirHost: () => opts.contextDirHost ?? '/nonexistent/context',
  } as unknown as JobLifecycleService;
  const jobs =
    opts.jobs ??
    ({
      findOne: async () => ({ id: 'job-1', repo_id: 'repo-1' }),
      // persistRow reflects the review status onto jobs.activity via syncReviewActivity — the fake must
      // accept the update (the live sync is asserted end-to-end in web-surface.halt.int.test.ts).
      update: vi.fn(async () => ({ affected: 1 })),
    } as unknown as Repository<JobEntity>);
  const stages = fakeStagesRepo();
  const harness = {
    create: () => ({
      onEvent: () => undefined,
      finish: async () => {
        opts.onFinish?.();
      },
      abort: async () => undefined,
      discard: async () => undefined,
    }),
  } as unknown as TurnHarnessFactory;
  const blockSink = {
    appendBlock: vi.fn(async () => undefined),
    appendBlockOnce: vi.fn(async () => undefined),
  } as unknown as BlockSink;
  return new PlanReviewService(
    engine,
    fakeCreds,
    lifecycle,
    jobs,
    opts.threads,
    stages,
    harness,
    fakeElection,
    blockSink,
  );
}

const baseInput: PlanReviewInput = {
  jobId: 'job-1',
  orgId: 'org-1',
  goal: 'g',
  overview: 'o',
  decisions: [],
  threadTitles: ['backend'],
};

describe('PlanReviewService.review', () => {
  it('a fresh clean review persists a complete row and returns no findings', async () => {
    const threads = fakePlanReviewThreadsRepo();
    const svc = makeService({ threads });
    const out = await svc.review(baseInput);
    expect(out.status).toBe('complete');
    expect(out.findings).toEqual([]);
    expect((await svc.loadRow('job-1'))?.status).toBe('complete');
  });

  it('parses + persists severity findings', async () => {
    const threads = fakePlanReviewThreadsRepo();
    const svc = makeService({
      threads,
      engineRun: async () =>
        ({
          result: 'FINDING [BLOCKING]: x — breaks build\nFINDING [ADVISORY]: y — nicer',
          sessionId: 's',
        }) as EngineRunResult,
    });
    const out = await svc.review(baseInput);
    expect(out.findings.map((f) => f.severity)).toEqual(['BLOCKING', 'ADVISORY']);
  });

  it('flips the control row complete BEFORE persisting the reply transcript (no re-drive window)', async () => {
    // The invariant that stops the doubled review turn: a re-drive needs status='running', so the row
    // must reach 'complete' before the reply becomes durable. Assert that relative order.
    const order: string[] = [];
    const threads = fakePlanReviewThreadsRepo();
    const origUpdate = (
      threads as unknown as { update: (w: unknown, p: Partial<ThreadEntity>) => Promise<void> }
    ).update;
    (threads as unknown as { update: unknown }).update = vi.fn(
      async (where: unknown, patch: Partial<ThreadEntity>) => {
        if ((patch as { config?: { status?: string } }).config?.status === 'complete') {
          order.push('row:complete');
        }
        return origUpdate(where, patch);
      },
    );
    const svc = makeService({ threads, onFinish: () => order.push('reply:persisted') });
    await svc.review(baseInput);
    expect(order).toEqual(['row:complete', 'reply:persisted']);
    // The row is terminal, so the backstop worklist no longer sees it → it can never be re-driven.
    expect((await svc.loadRow('job-1'))?.status).toBe('complete');
    expect(await svc.findRunningReviews()).toEqual([]);
  });

  it('records failed (no throw) when no sandbox can be attached', async () => {
    const threads = fakePlanReviewThreadsRepo();
    const svc = makeService({ threads, ensureContainer: null });
    const out = await svc.review(baseInput);
    expect(out.status).toBe('failed');
    expect((await svc.loadRow('job-1'))?.status).toBe('failed');
  });

  it('stops at the re-review ceiling without a new engine run', async () => {
    const threads = fakePlanReviewThreadsRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', resume_count: 8, status: 'complete', codex_session_id: 's' },
    ]);
    const svc = makeService({ threads });
    const out = await svc.review(baseInput);
    expect(out.ceilingHit).toBe(true);
  });
});

describe('PlanReviewService.review — resume_count is the plan-version/round (D2)', () => {
  it('a same-spec_hash re-drive keeps resume_count; a changed-spec_hash review bumps it', async () => {
    // A real specs dir so hashSpecs() returns a stable, non-null hash (the plan-version fingerprint).
    const root = await mkdtemp(join(tmpdir(), 'plan-review-d2-'));
    const specsDir = join(root, 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'plan.md'), 'v1');
    try {
      const threads = fakePlanReviewThreadsRepo();
      const svc = makeService({ threads, contextDirHost: root });

      // First review of this plan version: fresh row, round 0.
      await svc.review(baseInput);
      expect((await svc.loadRow('job-1'))?.resume_count).toBe(0);

      // Recovery re-drive of the SAME plan version (specs unchanged) → round stays 0.
      await svc.review(baseInput);
      expect((await svc.loadRow('job-1'))?.resume_count).toBe(0);

      // Atlas revised the plan → the specs (and their hash) change → a genuine new round bumps to 1.
      await writeFile(join(specsDir, 'plan.md'), 'v2 — revised');
      await svc.review(baseInput);
      expect((await svc.loadRow('job-1'))?.resume_count).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PlanReviewService.reviewForCurrentSpecs (the propose_plan gate)', () => {
  it('returns the row when terminal and spec_hash matches the current specs (both null offline)', async () => {
    const threads = fakePlanReviewThreadsRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'complete', spec_hash: null },
    ]);
    const svc = makeService({ threads });
    const gate = await svc.reviewForCurrentSpecs('job-1', 'org-1');
    expect(gate?.row.id).toBe('r');
  });

  it('a FAILED review still satisfies the gate (a review that ran, even erroring)', async () => {
    const threads = fakePlanReviewThreadsRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'failed', spec_hash: null, error: 'boom' },
    ]);
    const svc = makeService({ threads });
    const gate = await svc.reviewForCurrentSpecs('job-1', 'org-1');
    expect(gate?.row.status).toBe('failed');
  });

  it('refuses when the spec_hash no longer matches (specs changed since review)', async () => {
    const threads = fakePlanReviewThreadsRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'complete', spec_hash: 'OLDHASH' },
    ]);
    const svc = makeService({ threads });
    expect(await svc.reviewForCurrentSpecs('job-1', 'org-1')).toBeNull();
  });

  it('ESCAPE VALVE: accepts a mismatched spec_hash once the re-review ceiling is exhausted', async () => {
    // Post-ceiling, review() can never re-run, so a later spec edit (mismatched hash) must NOT deadlock
    // propose_plan forever. A terminal review that hit the ceiling is accepted despite the mismatch; a
    // below-ceiling mismatch is still refused (the normal revise → re-review loop).
    const threads = fakePlanReviewThreadsRepo([
      {
        id: 'r',
        job_id: 'job-1',
        org_id: 'org-1',
        status: 'complete',
        spec_hash: 'OLDHASH',
        resume_count: 8, // >= default ceiling (8)
      },
    ]);
    const svc = makeService({ threads });
    const gate = await svc.reviewForCurrentSpecs('job-1', 'org-1');
    expect(gate?.row.id).toBe('r');
    // currentHash is null (no specs dir) — the escape returns it as-is, not the frozen OLDHASH.
    expect(gate?.specHash).toBeNull();

    // One round below the ceiling, the same mismatch is still refused.
    const belowCeiling = fakePlanReviewThreadsRepo([
      { id: 'r2', job_id: 'job-1', org_id: 'org-1', status: 'complete', spec_hash: 'OLDHASH', resume_count: 7 },
    ]);
    const svc2 = makeService({ threads: belowCeiling });
    expect(await svc2.reviewForCurrentSpecs('job-1', 'org-1')).toBeNull();
  });

  it('refuses when the only review is still running', async () => {
    const threads = fakePlanReviewThreadsRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'running', spec_hash: null },
    ]);
    const svc = makeService({ threads });
    expect(await svc.reviewForCurrentSpecs('job-1', 'org-1')).toBeNull();
  });
});

describe('PlanReviewService.findRunningReviews (backstop worklist)', () => {
  it('returns only running rows', async () => {
    const threads = fakePlanReviewThreadsRepo([
      { id: 'a', job_id: 'j1', status: 'running' },
      { id: 'b', job_id: 'j2', status: 'complete' },
    ]);
    const svc = makeService({ threads });
    const running = await svc.findRunningReviews();
    expect(running.map((r) => r.id)).toEqual(['a']);
  });
});

// A capturing `jobs` repo that records every `activity` value written (in order).
function capturingJobsRepo() {
  const activities: string[] = [];
  return {
    _activities: () => activities,
    repo: {
      findOne: async () => ({ id: 'job-1', repo_id: 'repo-1' }),
      update: vi.fn(async (_where: unknown, patch: { activity?: string }) => {
        if (patch.activity !== undefined) activities.push(patch.activity);
        return { affected: 1 };
      }),
    } as unknown as Repository<JobEntity>,
  };
}

describe('PlanReviewService.review — reflects onto jobs.activity (§6)', () => {
  it('writes plan_review while running, then idle once the review completes', async () => {
    const threads = fakePlanReviewThreadsRepo();
    const cap = capturingJobsRepo();
    const svc = makeService({ threads, jobs: cap.repo });
    await svc.review(baseInput);
    // persistRow('running') → plan_review, persistRow('complete') → idle, in that order.
    expect(cap._activities()).toEqual(['plan_review', 'idle']);
  });

  it('writes plan_review then idle even when the review fails (no sandbox)', async () => {
    const threads = fakePlanReviewThreadsRepo();
    const cap = capturingJobsRepo();
    const svc = makeService({ threads, jobs: cap.repo, ensureContainer: null });
    await svc.review(baseInput);
    expect(cap._activities()[cap._activities().length - 1]).toBe('idle');
  });
});

// ── BrainStoreService activity writers (§4b + §7 nesting) ────────────────────────────────────────

/** A capturing `jobs` repo shared by the BrainStoreService unit tests. */
function fakeStoreJobs() {
  const patches: Array<Record<string, unknown>> = [];
  return {
    _patches: () => patches,
    repo: {
      findOne: vi.fn(async () => ({ id: 'job-1', session_resume: null })),
      update: vi.fn(async (_where: unknown, patch: Record<string, unknown>) => {
        patches.push(patch);
        return { affected: 1 };
      }),
    } as unknown as Repository<JobEntity>,
  };
}

/** `endTurnActivity` now checks a `plan_review`-role thread's `config.status` via
 *  `this.threads.createQueryBuilder(...).getExists()` (the retired `codex_reviews.status` read). */
function fakeThreadsRepoForBrainStore(reviewing: boolean) {
  return {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      for (const m of ['where', 'andWhere']) qb[m] = () => qb;
      qb.getExists = vi.fn(async () => reviewing);
      return qb;
    },
  } as unknown as Repository<ThreadEntity>;
}

function makeBrainStore(opts: { reviewRunning: boolean; jobs: Repository<JobEntity> }) {
  const threads = fakeThreadsRepoForBrainStore(opts.reviewRunning);
  const stub = {} as never;
  return new BrainStoreService(
    opts.jobs,
    stub, // messages
    stub, // records
    threads,
    stub, // stages
    stub, // stimuli
    stub, // dataSource
    stub, // titler
    { onBlockerResolved: vi.fn().mockResolvedValue(undefined) } as unknown as JobDependencyService,
  );
}

describe('BrainStoreService activity writers', () => {
  it('setActivity writes the given activity', async () => {
    const jobs = fakeStoreJobs();
    const store = makeBrainStore({ reviewRunning: false, jobs: jobs.repo });
    await store.setActivity('job-1', 'turn');
    expect(jobs._patches()).toEqual([{ activity: 'turn' }]);
  });

  it('setHalted(true) clears activity to idle; setHalted(false) leaves activity untouched', async () => {
    const jobs = fakeStoreJobs();
    const store = makeBrainStore({ reviewRunning: false, jobs: jobs.repo });
    await store.setHalted('job-1', true);
    await store.setHalted('job-1', false);
    expect(jobs._patches()).toEqual([
      { halted: true, activity: 'idle' },
      { halted: false },
    ]);
  });

  it('endTurnActivity → idle when no review is running (turn ended, nothing outlives it)', async () => {
    const jobs = fakeStoreJobs();
    const store = makeBrainStore({ reviewRunning: false, jobs: jobs.repo });
    await store.endTurnActivity('job-1');
    expect(jobs._patches()).toEqual([{ activity: 'idle' }]);
  });

  it('endTurnActivity → plan_review while a plan_review thread still runs (review outlives the turn)', async () => {
    // The §7 crux: the turn finalizes first but a `review_plan` review is still `running`, so activity must
    // stay plan_review (dot suppressed) — never landing idle until the review row itself leaves running.
    const jobs = fakeStoreJobs();
    const store = makeBrainStore({ reviewRunning: true, jobs: jobs.repo });
    await store.endTurnActivity('job-1');
    expect(jobs._patches()).toEqual([{ activity: 'plan_review' }]);
  });
});
