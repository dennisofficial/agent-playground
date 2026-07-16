import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { JobBootstrapService } from '../job-bootstrap';
import { AgentSessionManager } from './agent-session-manager.service';
import type { Message, TurnEnvelope } from '../domain';

/**
 * MECHANISM validation for brain-session compaction (see the `atlas-brain-compaction` design). Boots the
 * REAL AppModule (agent surface) against live test Postgres, stubbing only the external boundaries — then
 * calls the REAL `AgentSessionManager.runCompaction` so the whole path runs for real: the summarization
 * engine turn (FakeEngineRunner returns canned review-mode text), the durable reseed (`session_id` nulled +
 * `pending_compaction_seed` stashed on `job_sandboxes`), and the inspectable summary (`appendCompactionSummary`
 * → a `build_event` message carrying `meta.compactionSummary`). The real-LLM end-to-end (dispatch_build →
 * real Opus summary → fresh-session fold) is the deferred billed E2E; this proves the plumbing with $0.
 */
const TEAM_ID = '55555555-5555-4555-8555-555555555555'; // sentinel org uuid
const PROJECT_SLUG = 'compaction-it';

describe('brain-session compaction (live Postgres, stubbed engine)', () => {
  let app: NestExpressApplication;
  let mgr: AgentSessionManager;
  let dataSource: DataSource;
  let bootstrap: JobBootstrapService;

  const prevSurface = process.env.SURFACE;
  const prevToken = process.env.CLAUDE_OAUTH_TOKEN;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    // Guarantee engine-auth resolves (env fallback) without throwing before the stubbed run.
    process.env.CLAUDE_OAUTH_TOKEN =
      process.env.CLAUDE_OAUTH_TOKEN ?? 'it-fake-token';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(new FakeEngineRunner())
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(new FakeGithubPrService())
      .overrideProvider(JobTitler)
      .useValue(new FakeThreadTitler())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.enableShutdownHooks();
    await app.init();

    mgr = app.get(AgentSessionManager);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    bootstrap = app.get(JobBootstrapService);
    await purge(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) await purge(dataSource);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
    if (prevToken === undefined) delete process.env.CLAUDE_OAUTH_TOKEN;
    else process.env.CLAUDE_OAUTH_TOKEN = prevToken;
  });

  async function seedJobWithSession(
    sessionId: string | null,
  ): Promise<{ jobId: string; repoId: string }> {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'Compaction Org', 'compaction-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, $2, 'Compaction Repo', 'https://github.com/acme/compaction.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID, PROJECT_SLUG],
    );
    const repoId = repoRow.id;
    const [job]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'compaction subject') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const jobId = job.id;
    await bootstrap.ensurePlanningThreadGroup(jobId, TEAM_ID);
    await dataSource.query(
      `INSERT INTO job_sandboxes (org_id, job_id, repo_id, worktree_path, lifecycle, session_id)
         VALUES ($1, $2, $3, '/tmp/compaction-it-worktree', 'attached', $4)`,
      [TEAM_ID, jobId, repoId, sessionId],
    );
    return { jobId, repoId };
  }

  const stim = (jobId: string, repoId: string): TurnEnvelope => ({
    message: {
      id: 'compaction-it-stimulus',
      orgId: TEAM_ID,
      repoId,
      jobId,
      receivedAt: new Date().toISOString(),
      type: 'compaction',
    } as unknown as Message,
    id: 'compaction-it-stimulus',
    orgId: TEAM_ID,
    repoId,
    jobId,
    body: '',
    author: { id: 'atlas', displayName: 'Atlas' },
    replyRoute: { surfaceId: 'agent', jobRef: 'C-IT' },
    receivedAt: new Date(),
  });

  it('reseeds the session and stores an inspectable summary', async () => {
    const { jobId, repoId } = await seedJobWithSession('fat-session-abc');

    // Drive the REAL compaction path. FakeEngineRunner answers the mode:'review' summary turn with canned text.
    await (
      mgr as unknown as {
        runCompaction: (
          s: TurnEnvelope,
          sandbox: { worktreePath: string; containerId?: string | null },
          row: { session_id: string | null } | null,
          sessionId: string | undefined,
        ) => Promise<void>;
      }
    ).runCompaction(
      stim(jobId, repoId),
      { worktreePath: '/tmp/compaction-it-worktree', containerId: null },
      { session_id: 'fat-session-abc' },
      'fat-session-abc',
    );

    // 1. Reseed: the fat session is abandoned and a lean seed is stashed durably; the abandon marker is
    //    KEPT (recovery keeps skipping the old session until the fresh one is born).
    const [row]: Array<{
      session_id: string | null;
      pending_compaction_seed: string | null;
      compacting_session_id: string | null;
    }> = await dataSource.query(
      `SELECT session_id, pending_compaction_seed, compacting_session_id FROM job_sandboxes WHERE job_id = $1`,
      [jobId],
    );
    expect(row.session_id).toBeNull();
    expect(row.pending_compaction_seed).toBeTruthy();
    expect(row.compacting_session_id).toBe('fat-session-abc');
    // The seed carries the continuation preamble + the (stubbed) summary text.
    expect(row.pending_compaction_seed).toContain('<session_compacted>');
    expect(row.pending_compaction_seed).toContain('(e2e fake) review turn');

    // 2. Inspectable summary: a durable build_event message carries the full summary in meta.
    const [msg]: Array<{
      text: string;
      kind: string;
      meta: { compactionSummary?: string } | null;
    }> = await dataSource.query(
      `SELECT text, kind, meta FROM transcript_messages
           WHERE job_id = $1 AND kind = 'build_event' AND meta ? 'compactionSummary'`,
      [jobId],
    );
    expect(msg).toBeTruthy();
    expect(msg.kind).toBe('build_event');
    expect(msg.text).toContain('Compacted the planning conversation');
    expect(msg.meta?.compactionSummary).toContain('(e2e fake) review turn');
  }, 45_000);

  it('clears the abandon marker + leaves the session intact when the summary turn yields nothing', async () => {
    const { jobId, repoId } = await seedJobWithSession('fat-empty-xyz');
    const runner = mgr as unknown as { engineRunner: { run: unknown } };
    const orig = runner.engineRunner.run;
    runner.engineRunner.run = async () => ({ result: '', sessionId: 'x' }); // force a non-clean/empty summary
    try {
      await (
        mgr as unknown as {
          runCompaction: (
            s: TurnEnvelope,
            sandbox: { worktreePath: string; containerId?: string | null },
            row: { session_id: string | null } | null,
            sessionId: string | undefined,
          ) => Promise<void>;
        }
      ).runCompaction(
        stim(jobId, repoId),
        { worktreePath: '/tmp/compaction-it-worktree', containerId: null },
        { session_id: 'fat-empty-xyz' },
        'fat-empty-xyz',
      );
    } finally {
      runner.engineRunner.run = orig;
    }

    const [row]: Array<{
      session_id: string | null;
      compacting_session_id: string | null;
    }> = await dataSource.query(
      `SELECT session_id, compacting_session_id FROM job_sandboxes WHERE job_id = $1`,
      [jobId],
    );
    // Session NOT abandoned; marker cleared → recovery is never suppressed for a still-live session.
    expect(row.session_id).toBe('fat-empty-xyz');
    expect(row.compacting_session_id).toBeNull();
    const [{ n }]: Array<{ n: string }> = await dataSource.query(
      `SELECT count(*)::text AS n FROM transcript_messages WHERE job_id = $1 AND meta ? 'compactionSummary'`,
      [jobId],
    );
    expect(n).toBe('0'); // no pill for a no-op compaction
  }, 30_000);

  it('completeCompaction reseeds + writes exactly one inspectable pill, keeping the marker', async () => {
    const { jobId } = await seedJobWithSession('fat-complete-1');
    await dataSource.query(
      `UPDATE job_sandboxes SET compacting_session_id = 'fat-complete-1' WHERE job_id = $1`,
      [jobId],
    );
    await (
      mgr as unknown as {
        completeCompaction: (j: string, o: string, s: string) => Promise<void>;
      }
    ).completeCompaction(jobId, TEAM_ID, 'lean handoff summary');

    const [row]: Array<{
      session_id: string | null;
      pending_compaction_seed: string | null;
      compacting_session_id: string | null;
    }> = await dataSource.query(
      `SELECT session_id, pending_compaction_seed, compacting_session_id FROM job_sandboxes WHERE job_id = $1`,
      [jobId],
    );
    expect(row.session_id).toBeNull();
    expect(row.pending_compaction_seed).toContain('lean handoff summary');
    expect(row.compacting_session_id).toBe('fat-complete-1'); // kept until the fresh session is born

    const pills: Array<{ meta: { compactionSummary?: string } }> =
      await dataSource.query(
        `SELECT meta FROM transcript_messages WHERE job_id = $1 AND kind = 'build_event' AND meta ? 'compactionSummary'`,
        [jobId],
      );
    expect(pills).toHaveLength(1);
    expect(pills[0].meta.compactionSummary).toBe('lean handoff summary');
  }, 30_000);

  describe('compaction floor (shouldSkipCompaction)', () => {
    const skip = (jobId: string) =>
      (
        mgr as unknown as {
          shouldSkipCompaction: (j: string) => Promise<boolean>;
        }
      ).shouldSkipCompaction(jobId);

    // Seed a brain turn_meta block (no phaseId) with a given occupancy; build blocks carry phaseId.
    const seedTurnMeta = async (
      jobId: string,
      contextTokens: number | null,
      opts?: { phaseId?: string; contextLimit?: number },
    ) => {
      const meta: Record<string, unknown> = {
        usage: { inputTokens: 1 },
        contextTokens,
        contextLimit: opts?.contextLimit ?? 1_000_000,
        ...(opts?.phaseId ? { phaseId: opts.phaseId } : {}),
      };
      const threadId = await bootstrap.planningThreadId(jobId);
      await dataSource.query(
        `INSERT INTO transcript_messages (job_id, thread_id, author, author_id, author_bot_id, text, kind, meta)
           VALUES ($1, $2, 'Atlas', 'atlas', 'atlas', '', 'turn_meta', $3::jsonb)`,
        [jobId, threadId, JSON.stringify(meta)],
      );
    };

    it('SKIPS when the brain session is lean (below the floor)', async () => {
      const { jobId } = await seedJobWithSession('s-lean');
      await seedTurnMeta(jobId, 50_000); // 5% of 1M — well under the 0.3 floor
      expect(await skip(jobId)).toBe(true);
    });

    it('COMPACTS when the brain session is heavy (above the floor)', async () => {
      const { jobId } = await seedJobWithSession('s-fat');
      await seedTurnMeta(jobId, 600_000); // 60% of 1M — over the floor
      expect(await skip(jobId)).toBe(false);
    });

    it('COMPACTS when occupancy is unknown (no brain turn_meta)', async () => {
      const { jobId } = await seedJobWithSession('s-unknown');
      expect(await skip(jobId)).toBe(false);
    });

    it('ignores BUILD turn_meta (phaseId) — a lean build reading does not gate the brain', async () => {
      const { jobId } = await seedJobWithSession('s-buildonly');
      // Only a build turn_meta exists (tagged phaseId) reporting a tiny build-session occupancy.
      await seedTurnMeta(jobId, 10_000, { phaseId: 'step-1' });
      // Brain occupancy is unknown → compact (the build's 10k must NOT be read as the brain's).
      expect(await skip(jobId)).toBe(false);
    });
  });

  it('is a no-op when there is no live session to compact', async () => {
    const { jobId, repoId } = await seedJobWithSession(null);

    await (
      mgr as unknown as {
        runCompaction: (
          s: TurnEnvelope,
          sandbox: { worktreePath: string; containerId?: string | null },
          row: { session_id: string | null } | null,
          sessionId: string | undefined,
        ) => Promise<void>;
      }
    ).runCompaction(
      stim(jobId, repoId),
      { worktreePath: '/tmp/compaction-it-worktree', containerId: null },
      { session_id: null },
      undefined,
    );

    // No reseed, no pill — nothing was compacted.
    const [row]: Array<{ pending_compaction_seed: string | null }> =
      await dataSource.query(
        `SELECT pending_compaction_seed FROM job_sandboxes WHERE job_id = $1`,
        [jobId],
      );
    expect(row.pending_compaction_seed).toBeNull();
    const msgs: Array<{ n: string }> = await dataSource.query(
      `SELECT count(*)::text AS n FROM transcript_messages WHERE job_id = $1 AND meta ? 'compactionSummary'`,
      [jobId],
    );
    expect(msgs[0].n).toBe('0');
  }, 45_000);
});

async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(
    `DELETE FROM transcript_messages WHERE job_id IN (SELECT id FROM jobs WHERE org_id = $1)`,
  );
  await q(`DELETE FROM job_sandboxes WHERE org_id = $1`);
  await q(`DELETE FROM jobs WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
