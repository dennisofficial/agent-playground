import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  PlanReviewService,
  parsePlanFindings,
  renderFindingsDelivery,
  summarizeEngineError,
} from './plan-review.service';
import type { PlanReviewStartInput } from './plan-review.service';
import type { EngineRunnerPort, EngineRunResult, RunEngineArgs } from '../engine/engine.types';
import type { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import type { CredentialResolver } from '../onboarding';
import type { Repository } from 'typeorm';
import type { PlanReviewEntity } from '../persistence/entities';

/** Creds stub: no per-org secret → the engine uses its env fallback (these tests stub the engine). */
const fakeCreds = {
  engineAuth: async () => undefined,
} as unknown as CredentialResolver;

/** Leader-election stub: not draining (the default) — so the turn catch stamps `failed` as before.
 *  The shutdown-aware branch (isDraining → leave 'running') is exercised by a dedicated test below. */
const fakeElection = {
  isDraining: () => false,
} as unknown as import('../cluster').LeaderElectionService;

/**
 * R4 GATE TESTS — the ASYNC, durable PlanReviewService:
 *   - parsePlanFindings extracts FINDING: lines / recognises NO_FINDINGS.
 *   - start() opens a durable `plan_reviews` round (and enforces the round cap).
 *   - runReview() (re-)attaches the sandbox, runs ONE read-only Codex turn, and stamps the row terminal
 *     (complete / failed — failure is best-effort, never throws).
 *   - the boot-reconciliation finders + markDelivered behave.
 *   - renderFindingsDelivery frames the operator-visible + Atlas-facing body.
 *
 * The submit_plan / finalize_plan tool wiring is covered in `agent-session-manager.spec.ts`.
 */

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A fake EngineRunnerPort that records calls and returns a configured result. */
function fakeEngine(output: string): {
  engine: EngineRunnerPort;
  calls: Array<{ engine: string; mode: string; task: string }>;
} {
  const calls: Array<{ engine: string; mode: string; task: string }> = [];
  const engine: EngineRunnerPort = {
    run: vi.fn(async (args: RunEngineArgs) => {
      calls.push({ engine: args.engine, mode: args.mode, task: args.task });
      return { result: output, sessionId: 'rev-sess-1' };
    }),
  };
  return { engine, calls };
}

/** A fake EngineRunnerPort that throws on every run() call. */
function failingEngine(): EngineRunnerPort {
  return {
    run: vi.fn(async () => {
      throw new Error('engine boom');
    }),
  };
}

/**
 * A fake EngineRunnerPort whose run() HANGS — it never resolves on its own (simulating a wedged Codex
 * turn), but rejects if the caller aborts via `signal` (the real runner honors the signal). Used to prove
 * the watchdog stamps the row `failed` instead of leaving it stuck `running` forever.
 */
function hangingEngine(): EngineRunnerPort {
  return {
    run: vi.fn(
      (args: RunEngineArgs) =>
        new Promise<EngineRunResult>((_resolve, reject) => {
          args.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    ),
  };
}

const FAKE_SANDBOX = {
  repoId: 'test-proj',
  branch: 'main',
  worktreePath: '/wt/test',
  gitUrl: '',
};

/** Lifecycle stub whose ensureContainer returns the given sandbox (or null = no sandbox). */
function fakeLifecycle(
  sandbox:
    | typeof FAKE_SANDBOX
    | (typeof FAKE_SANDBOX & { containerId: string })
    | null,
) {
  return {
    ensureContainer: vi.fn(async () =>
      sandbox ? { sandbox, wasReset: false } : null,
    ),
  } as unknown as ThreadLifecycleService;
}

/** A tiny in-memory `plan_reviews` repository fake (only the methods the service uses). */
function makeReviewsRepo() {
  const rows: PlanReviewEntity[] = [];
  let seq = 1;
  const repo = {
    count: vi.fn(
      async (opts: { where: { thread_id: string } }) =>
        rows.filter((r) => r.thread_id === opts.where.thread_id).length,
    ),
    create: vi.fn(
      (data: Partial<PlanReviewEntity>) => ({ ...data }) as PlanReviewEntity,
    ),
    save: vi.fn(async (data: PlanReviewEntity) => {
      const row = {
        ...data,
        created_at: data.created_at ?? new Date(),
        updated_at: data.updated_at ?? new Date(),
        id: data.id ?? `rev-${seq++}`,
      } as PlanReviewEntity;
      rows.push(row);
      return row;
    }),
    findOne: vi.fn(
      async (opts: {
        where: { id?: string; thread_id?: string; status?: string };
        order?: { round?: 'ASC' | 'DESC' };
      }) => {
        const { id, thread_id, status } = opts.where;
        if (id) return rows.find((r) => r.id === id) ?? null;
        let matches = rows.filter(
          (r) =>
            (thread_id === undefined || r.thread_id === thread_id) &&
            (status === undefined || r.status === status),
        );
        if (opts.order?.round) {
          const dir = opts.order.round === 'DESC' ? -1 : 1;
          matches = [...matches].sort((a, b) => (a.round - b.round) * dir);
        }
        return matches[0] ?? null;
      },
    ),
    findOneOrFail: vi.fn(async (opts: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === opts.where.id);
      if (!r) throw new Error(`review ${opts.where.id} not found`);
      return r;
    }),
    update: vi.fn(
      async (where: { id: string }, patch: Partial<PlanReviewEntity>) => {
        const r = rows.find((x) => x.id === where.id);
        if (r) Object.assign(r, patch);
      },
    ),
    find: vi.fn(async (opts?: { where?: { status?: string } }) =>
      opts?.where?.status
        ? rows.filter((r) => r.status === opts.where!.status)
        : [...rows],
    ),
  };
  return { repo: repo as unknown as Repository<PlanReviewEntity>, rows };
}

const START_INPUT: PlanReviewStartInput = {
  threadId: 'th-r4-001',
  orgId: 'T-R4',
  decisionRecordId: 'rec-1',
  goal: 'Add OAuth2 login to the public API',
  overview: 'Add OAuth2 login to the API.',
  decisions: [
    {
      decisionClass: 'infrastructure',
      title: 'Auth provider',
      ruling: 'Use Auth0.',
    },
  ],
  trackTitles: [
    'Implement the OAuth2 callback handler.',
    'Add JWT validation middleware.',
  ],
};

// ── parsePlanFindings ──────────────────────────────────────────────────────────────────────────────

describe('parsePlanFindings', () => {
  it('returns empty string when output contains NO_FINDINGS', () => {
    expect(parsePlanFindings('NO_FINDINGS')).toBe('');
    expect(parsePlanFindings('The plan looks great.\nNO_FINDINGS')).toBe('');
  });

  it('extracts FINDING: lines stripping the prefix', () => {
    const output = [
      'Here is my review.',
      'FINDING: Track 1 brief is too vague to implement without re-asking.',
      'FINDING: Missing error-handling decision for OAuth callback failures.',
      'Looks otherwise ok.',
    ].join('\n');
    const result = parsePlanFindings(output);
    expect(result).toContain('Track 1 brief is too vague');
    expect(result).toContain('Missing error-handling decision');
    expect(result.split('\n')).toHaveLength(2);
  });

  it('returns empty string when no FINDING: lines and no NO_FINDINGS marker', () => {
    expect(
      parsePlanFindings('Some general commentary without any findings.'),
    ).toBe('');
  });

  it('is case-insensitive for the FINDING: prefix', () => {
    const result = parsePlanFindings(
      'finding: lower case finding\nFINDING: UPPER CASE FINDING',
    );
    expect(result.split('\n')).toHaveLength(2);
  });
});

// ── PlanReviewService.start ─────────────────────────────────────────────────────────────────────────

describe('PlanReviewService.start', () => {
  it('opens round 1 with a rendered prompt and a running row', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = new PlanReviewService(
      fakeEngine('').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

    const started = await service.start(START_INPUT);

    expect('reviewId' in started).toBe(true);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    expect(started.round).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('running');
    expect(rows[0].thread_id).toBe('th-r4-001');
    // The prompt is STRUCTURED: it leads with the operator's intent (goal) and embeds the overview +
    // tracks so a boot re-run needs no reconstruction.
    expect(rows[0].prompt).toContain('<intent>');
    expect(rows[0].prompt).toContain(
      'GOAL: Add OAuth2 login to the public API',
    );
    expect(rows[0].prompt).toContain('<authored_plan>');
    expect(rows[0].prompt).toContain('Add OAuth2 login to the API.'); // overview
    expect(rows[0].prompt).toContain('OAuth2 callback handler'); // a track
  });

  it('includes the originating ticket in the intent when present', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = new PlanReviewService(
      fakeEngine('').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

    await service.start({
      ...START_INPUT,
      ticket: {
        number: 42,
        title: 'Users want social login',
        body: 'Support Google sign-in on the API.',
      },
    });

    expect(rows[0].prompt).toContain(
      'ORIGINATING TICKET #42 — Users want social login',
    );
    expect(rows[0].prompt).toContain('Support Google sign-in on the API.');
  });

  it('enforces the round cap (default 3): the 4th round on a thread is capped', async () => {
    const { repo } = makeReviewsRepo();
    const service = new PlanReviewService(
      fakeEngine('').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

    await service.start(START_INPUT); // round 1
    await service.start(START_INPUT); // round 2
    await service.start(START_INPUT); // round 3
    const capped = await service.start(START_INPUT); // round 4 → capped

    expect('capped' in capped).toBe(true);
    expect((capped as { capped: true; round: number }).round).toBe(3);
  });
});

// ── PlanReviewService.runningReview (the finalize_plan gate) ─────────────────────────────────────────

describe('PlanReviewService.runningReview', () => {
  const makeService = (repo: Repository<PlanReviewEntity>) =>
    new PlanReviewService(
      fakeEngine('').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

  it('returns the in-flight round while a Codex turn is running', async () => {
    const { repo } = makeReviewsRepo();
    const service = makeService(repo);
    await service.start(START_INPUT); // round 1 → status 'running'

    const running = await service.runningReview('th-r4-001');
    expect(running).toEqual({ round: 1 });
  });

  it('returns null once the round completes (finalize is allowed)', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = makeService(repo);
    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    rows[0].status = 'complete'; // Codex finished

    expect(await service.runningReview('th-r4-001')).toBeNull();
  });

  it('returns null for a thread with no reviews', async () => {
    const { repo } = makeReviewsRepo();
    expect(await makeService(repo).runningReview('th-none')).toBeNull();
  });

  it('does NOT block on an orphaned `running` row older than the watchdog ceiling', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = makeService(repo);
    await service.start(START_INPUT); // round 1 → running
    // Simulate a crash orphan: the row has been 'running' far longer than the watchdog could allow in a
    // live process (its in-process timer died with the crash). The gate must not wedge finalize forever.
    rows[0].created_at = new Date(Date.now() - 90 * 60_000); // 90 min ago (default ceiling is 45 min)

    expect(await service.runningReview('th-r4-001')).toBeNull();
  });

  it('reports the latest round when an earlier one is still running', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = makeService(repo);
    await service.start(START_INPUT); // round 1
    rows[0].status = 'complete';
    await service.start(START_INPUT); // round 2 → running

    expect(await service.runningReview('th-r4-001')).toEqual({ round: 2 });
  });
});

// ── PlanReviewService.runReview ──────────────────────────────────────────────────────────────────────

describe('PlanReviewService.runReview', () => {
  it('runs ONE read-only Codex turn and stamps the row complete with findings', async () => {
    const { repo, rows } = makeReviewsRepo();
    const { engine, calls } = fakeEngine(
      'FINDING: The callback track brief is too vague.',
    );
    const service = new PlanReviewService(
      engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    const out = await service.runReview(started.reviewId);

    expect(calls).toHaveLength(1);
    expect(calls[0].engine).toBe('codex');
    expect(calls[0].mode).toBe('review');
    expect(calls[0].task).toContain('OAuth2 callback handler'); // ran against the stored prompt
    expect(out.status).toBe('complete');
    expect(out.findings).toContain('callback track brief is too vague');
    expect(rows[0].status).toBe('complete');
    expect(rows[0].findings).toContain('callback track brief is too vague');
    expect(rows[0].completed_at).toBeInstanceOf(Date);
  });

  it('NO_FINDINGS → complete with empty findings', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = new PlanReviewService(
      fakeEngine('NO_FINDINGS').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    const out = await service.runReview(started.reviewId);

    expect(out).toEqual({ status: 'complete', findings: '' });
    expect(rows[0].status).toBe('complete');
  });

  it('engine failure is best-effort: stamps failed + CAPTURES the reason, never throws', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = new PlanReviewService(
      failingEngine(),
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );

    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    const out = await service.runReview(started.reviewId);

    expect(out.status).toBe('failed');
    expect(out.findings).toBe('');
    expect(out.error).toContain('engine boom'); // the reason is surfaced, not swallowed
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('engine boom'); // …and durably persisted
    expect(rows[0].completed_at).toBeInstanceOf(Date);
  });

  it('shutdown drain: a turn aborted while draining is LEFT running (not stamped failed) so boot reconcile re-runs it', async () => {
    const { repo, rows } = makeReviewsRepo();
    const drainingElection = {
      isDraining: () => true,
    } as unknown as import('../cluster').LeaderElectionService;
    const service = new PlanReviewService(
      failingEngine(), // throws immediately (timedOut=false) — same as a drain-induced abort
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      drainingElection,
    );

    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    const out = await service.runReview(started.reviewId);

    expect(out.status).toBe('failed'); // the return shape is type-only; the DURABLE row is what matters
    expect(rows[0].status).toBe('running'); // NOT stamped failed — stays resumable
    expect(rows[0].completed_at).toBeNull(); // never stamped terminal
  });

  it('watchdog: a HUNG Codex turn is stamped failed (never left stuck running)', async () => {
    const { repo, rows } = makeReviewsRepo();
    // A 30ms ceiling so the test doesn't wait the real 45m. Read at construction → set before `new`.
    const prev = process.env['PLAN_REVIEW_TIMEOUT_MS'];
    process.env['PLAN_REVIEW_TIMEOUT_MS'] = '30';
    try {
      const service = new PlanReviewService(
        hangingEngine(), // run() never resolves on its own; rejects only on abort
        fakeCreds,
        fakeLifecycle(FAKE_SANDBOX),
        repo,
        fakeElection,
      );
      const started = await service.start(START_INPUT);
      if (!('reviewId' in started)) throw new Error('expected a started round');

      const out = await service.runReview(started.reviewId);

      expect(out.status).toBe('failed'); // resolved (did NOT hang) within the ceiling
      expect(out.findings).toBe('');
      expect(rows[0].status).toBe('failed'); // durably stamped — the row is no longer 'running'
      expect(rows[0].completed_at).toBeInstanceOf(Date);
    } finally {
      if (prev === undefined) delete process.env['PLAN_REVIEW_TIMEOUT_MS'];
      else process.env['PLAN_REVIEW_TIMEOUT_MS'] = prev;
    }
  });

  it('no sandbox (ensureContainer null): stamps failed + records why', async () => {
    const { repo, rows } = makeReviewsRepo();
    const { engine, calls } = fakeEngine('NO_FINDINGS');
    const service = new PlanReviewService(
      engine,
      fakeCreds,
      fakeLifecycle(null),
      repo,
      fakeElection,
    );

    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    const out = await service.runReview(started.reviewId);

    expect(calls).toHaveLength(0); // never reached the engine
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/sandbox/i);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toMatch(/sandbox/i);
  });

  it('threads containerId through to the engine target when the sandbox is docker', async () => {
    const { repo } = makeReviewsRepo();
    const { engine } = fakeEngine('NO_FINDINGS');
    const service = new PlanReviewService(
      engine,
      fakeCreds,
      fakeLifecycle({ ...FAKE_SANDBOX, containerId: 'container-abc123' }),
      repo,
      fakeElection,
    );

    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');
    await service.runReview(started.reviewId);

    const runArgs = (engine.run as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as RunEngineArgs;
    expect(runArgs.target?.containerId).toBe('container-abc123');
  });
});

// ── delivery bookkeeping + boot finders ──────────────────────────────────────────────────────────────

describe('PlanReviewService — delivery + boot reconciliation', () => {
  it('markDelivered stamps delivered_at', async () => {
    const { repo, rows } = makeReviewsRepo();
    const service = new PlanReviewService(
      fakeEngine('NO_FINDINGS').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );
    const started = await service.start(START_INPUT);
    if (!('reviewId' in started)) throw new Error('expected a started round');

    await service.markDelivered(started.reviewId);
    expect(rows[0].delivered_at).toBeInstanceOf(Date);
  });

  it('findIncompleteReviews returns rows still running (Codex turn lost to a restart)', async () => {
    const { repo } = makeReviewsRepo();
    const service = new PlanReviewService(
      fakeEngine('NO_FINDINGS').engine,
      fakeCreds,
      fakeLifecycle(FAKE_SANDBOX),
      repo,
      fakeElection,
    );
    await service.start(START_INPUT); // status 'running'

    const incomplete = await service.findIncompleteReviews();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].status).toBe('running');
  });
});

// ── renderFindingsDelivery ───────────────────────────────────────────────────────────────────────────

describe('renderFindingsDelivery', () => {
  it('with findings: shows them + instructs submit_plan / finalize_plan', () => {
    const body = renderFindingsDelivery(
      '• Track 1 too vague.\n• Missing decision.',
      1,
      false,
    );
    expect(body).toContain('Codex plan review');
    expect(body).toContain('Track 1 too vague');
    expect(body).toContain('Missing decision');
    expect(body).toContain('submit_plan');
    expect(body).toContain('finalize_plan');
  });

  it('clean (no findings): says no findings + points at finalize_plan', () => {
    const body = renderFindingsDelivery('', 2, false);
    expect(body).toContain('no findings');
    expect(body).toContain('finalize_plan');
  });

  it('cap reached: tells Atlas to finalize over remaining findings', () => {
    const body = renderFindingsDelivery('• Still vague.', 3, true);
    expect(body).toContain('cap reached');
    expect(body).toContain('finalize_plan');
  });

  it('failed: reports the review could NOT run — never "the plan looks solid"', () => {
    const body = renderFindingsDelivery('', 1, false, 'failed');
    expect(body).toContain('could NOT run');
    expect(body).not.toContain('looks solid');
    expect(body).not.toContain('no findings');
  });

  it('failed: SURFACES the failure reason when one is given', () => {
    const body = renderFindingsDelivery(
      '',
      1,
      false,
      'failed',
      "The 'gpt-5-codex' model is not supported",
    );
    expect(body).toContain('could NOT run');
    expect(body).toContain("The 'gpt-5-codex' model is not supported");
  });
});

describe('summarizeEngineError', () => {
  it('extracts the embedded JSON `message` from a model-API error', () => {
    const raw =
      'in-sandbox engine turn failed: Error: {"type":"error","status":400,"error":' +
      '{"message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}\n' +
      '    at EngineCore.runCodex (file:///…)';
    expect(summarizeEngineError(new Error(raw))).toBe(
      "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('falls back to the first line when there is no embedded message, and caps length', () => {
    expect(summarizeEngineError(new Error('boom\nat stack'))).toBe('boom');
    expect(summarizeEngineError('x'.repeat(500)).length).toBeLessThanOrEqual(
      300,
    );
  });
});
