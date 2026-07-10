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
import type { CodexReviewEntity, JobEntity, ThreadEntity } from '../persistence/entities';
import type { BlockSink, TurnHarnessFactory } from '../surface';

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
 *   - review() runs ONE Codex turn, persists the single `codex_reviews` row, resumes the session.
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

/** A minimal in-memory fake of the `codex_reviews` repo (one row per job in these tests). */
function fakeReviewRepo(seed: Partial<CodexReviewEntity>[] = []) {
  const rows = seed.map((r, i) => ({
    id: r.id ?? `rev-${i}`,
    job_id: r.job_id,
    org_id: r.org_id,
    resume_count: r.resume_count ?? 0,
    status: r.status ?? 'running',
    findings: r.findings ?? null,
    error: r.error ?? null,
    codex_session_id: r.codex_session_id ?? null,
    spec_hash: r.spec_hash ?? null,
    created_at: r.created_at ?? new Date(2026, 0, 1, 0, i),
    updated_at: r.updated_at ?? new Date(2026, 0, 1, 0, i),
  })) as CodexReviewEntity[];
  return {
    _rows: () => rows,
    create: (r: Partial<CodexReviewEntity>) => ({ id: 'rev-new', ...r }) as CodexReviewEntity,
    save: vi.fn(async (r: CodexReviewEntity) => {
      const existing = rows.find((x) => x.id === r.id);
      if (existing) Object.assign(existing, r);
      else
        rows.push({
          ...r,
          created_at: r.created_at ?? new Date(),
          updated_at: r.updated_at ?? new Date(),
        } as CodexReviewEntity);
      return r;
    }),
    update: vi.fn(async (where: { id: string }, patch: Partial<CodexReviewEntity>) => {
      const row = rows.find((x) => x.id === where.id);
      if (row) Object.assign(row, patch, { updated_at: new Date() });
    }),
    findOne: vi.fn(async ({ where }: { where: { job_id?: string; status?: string } }) => {
      const matches = rows.filter(
        (x) =>
          (where.job_id == null || x.job_id === where.job_id) &&
          (where.status == null || x.status === where.status),
      );
      return matches.sort((a, b) => +b.created_at - +a.created_at)[0] ?? null;
    }),
    findOneOrFail: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error('not found');
      return r;
    }),
    find: vi.fn(async ({ where }: { where: { status?: string } }) =>
      rows.filter((x) => where.status == null || x.status === where.status),
    ),
  } as unknown as Repository<CodexReviewEntity> & { _rows: () => CodexReviewEntity[] };
}

function makeService(opts: {
  reviews: ReturnType<typeof fakeReviewRepo>;
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
  // The render-only `plan_review` thread row is best-effort — a no-op stub is enough for these tests.
  const threads = {
    findOne: async () => null,
    create: (x: unknown) => x,
    save: vi.fn(async () => undefined),
  } as unknown as Repository<ThreadEntity>;
  const harness = {
    create: () => ({
      onEvent: () => undefined,
      finish: async () => {
        opts.onFinish?.();
      },
      abort: async () => undefined,
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
    opts.reviews as unknown as Repository<CodexReviewEntity>,
    jobs,
    threads,
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
    const reviews = fakeReviewRepo();
    const svc = makeService({ reviews });
    const out = await svc.review(baseInput);
    expect(out.status).toBe('complete');
    expect(out.findings).toEqual([]);
    expect(reviews._rows()[0].status).toBe('complete');
  });

  it('parses + persists severity findings', async () => {
    const reviews = fakeReviewRepo();
    const svc = makeService({
      reviews,
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
    const reviews = fakeReviewRepo();
    const origUpdate = (reviews as unknown as { update: (w: unknown, p: { status?: string }) => Promise<void> }).update;
    (reviews as unknown as { update: unknown }).update = vi.fn(
      async (where: unknown, patch: { status?: string }) => {
        if (patch.status === 'complete') order.push('row:complete');
        return origUpdate(where, patch);
      },
    );
    const svc = makeService({ reviews, onFinish: () => order.push('reply:persisted') });
    await svc.review(baseInput);
    expect(order).toEqual(['row:complete', 'reply:persisted']);
    // The row is terminal, so the backstop worklist no longer sees it → it can never be re-driven.
    expect(reviews._rows()[0].status).toBe('complete');
    expect(await svc.findRunningReviews()).toEqual([]);
  });

  it('records failed (no throw) when no sandbox can be attached', async () => {
    const reviews = fakeReviewRepo();
    const svc = makeService({ reviews, ensureContainer: null });
    const out = await svc.review(baseInput);
    expect(out.status).toBe('failed');
    expect(reviews._rows()[0].status).toBe('failed');
  });

  it('stops at the re-review ceiling without a new engine run', async () => {
    const reviews = fakeReviewRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', resume_count: 8, status: 'complete', codex_session_id: 's' },
    ]);
    const svc = makeService({ reviews });
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
      const reviews = fakeReviewRepo();
      const svc = makeService({ reviews, contextDirHost: root });

      // First review of this plan version: fresh row, round 0.
      await svc.review(baseInput);
      expect(reviews._rows()[0].resume_count).toBe(0);

      // Recovery re-drive of the SAME plan version (specs unchanged) → round stays 0.
      await svc.review(baseInput);
      expect(reviews._rows()[0].resume_count).toBe(0);

      // Atlas revised the plan → the specs (and their hash) change → a genuine new round bumps to 1.
      await writeFile(join(specsDir, 'plan.md'), 'v2 — revised');
      await svc.review(baseInput);
      expect(reviews._rows()[0].resume_count).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PlanReviewService.reviewForCurrentSpecs (the propose_plan gate)', () => {
  it('returns the row when terminal and spec_hash matches the current specs (both null offline)', async () => {
    const reviews = fakeReviewRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'complete', spec_hash: null },
    ]);
    const svc = makeService({ reviews });
    const gate = await svc.reviewForCurrentSpecs('job-1', 'org-1');
    expect(gate?.row.id).toBe('r');
  });

  it('a FAILED review still satisfies the gate (a review that ran, even erroring)', async () => {
    const reviews = fakeReviewRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'failed', spec_hash: null, error: 'boom' },
    ]);
    const svc = makeService({ reviews });
    const gate = await svc.reviewForCurrentSpecs('job-1', 'org-1');
    expect(gate?.row.status).toBe('failed');
  });

  it('refuses when the spec_hash no longer matches (specs changed since review)', async () => {
    const reviews = fakeReviewRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'complete', spec_hash: 'OLDHASH' },
    ]);
    const svc = makeService({ reviews });
    expect(await svc.reviewForCurrentSpecs('job-1', 'org-1')).toBeNull();
  });

  it('refuses when the only review is still running', async () => {
    const reviews = fakeReviewRepo([
      { id: 'r', job_id: 'job-1', org_id: 'org-1', status: 'running', spec_hash: null },
    ]);
    const svc = makeService({ reviews });
    expect(await svc.reviewForCurrentSpecs('job-1', 'org-1')).toBeNull();
  });
});

describe('PlanReviewService.findRunningReviews (backstop worklist)', () => {
  it('returns only running rows', async () => {
    const reviews = fakeReviewRepo([
      { id: 'a', job_id: 'j1', status: 'running' },
      { id: 'b', job_id: 'j2', status: 'complete' },
    ]);
    const svc = makeService({ reviews });
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
    const reviews = fakeReviewRepo();
    const cap = capturingJobsRepo();
    const svc = makeService({ reviews, jobs: cap.repo });
    await svc.review(baseInput);
    // persistRow('running') → plan_review, persistRow('complete') → idle, in that order.
    expect(cap._activities()).toEqual(['plan_review', 'idle']);
  });

  it('writes plan_review then idle even when the review fails (no sandbox)', async () => {
    const reviews = fakeReviewRepo();
    const cap = capturingJobsRepo();
    const svc = makeService({ reviews, jobs: cap.repo, ensureContainer: null });
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
      update: vi.fn(async (_where: unknown, patch: Record<string, unknown>) => {
        patches.push(patch);
        return { affected: 1 };
      }),
    } as unknown as Repository<JobEntity>,
  };
}

function makeBrainStore(opts: { reviewRunning: boolean; jobs: Repository<JobEntity> }) {
  const reviews = {
    exists: vi.fn(async () => opts.reviewRunning),
  } as unknown as Repository<CodexReviewEntity>;
  const stub = {} as never;
  return new BrainStoreService(
    opts.jobs,
    stub, // messages
    stub, // records
    stub, // threads
    stub, // steps
    stub, // stimuli
    reviews,
    stub, // dataSource
    stub, // titler
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

  it('endTurnActivity → plan_review while a codex_reviews row still runs (review outlives the turn)', async () => {
    // The §7 crux: the turn finalizes first but a `review_plan` review is still `running`, so activity must
    // stay plan_review (dot suppressed) — never landing idle until the review row itself leaves running.
    const jobs = fakeStoreJobs();
    const store = makeBrainStore({ reviewRunning: true, jobs: jobs.repo });
    await store.endTurnActivity('job-1');
    expect(jobs._patches()).toEqual([{ activity: 'plan_review' }]);
  });
});
