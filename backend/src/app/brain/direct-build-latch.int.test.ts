import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import type { ChatStimulus } from '../domain';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { DRIVER_REPO } from '../driver';
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
import { AgentSessionManager } from './agent-session-manager.service';

/**
 * LIVE int test for the direct-build turn-end latch (decision d3). Boots the REAL AppModule against live
 * Postgres, faking only the external boundaries this thread does NOT own: the GitHub PR HTTP client
 * (`FakeGithubPrService` returns a PR for the head branch), the LLM engine, git, and the repo resolver
 * (supplies a token so `discoverOpenPr` proceeds). Everything the thread DOES own runs for real:
 * `AgentSessionManager.latchDirectBuildAtTurnEnd` → the real `BuildShipService.latchPr` →
 * `discoverOpenPr` → the real `setPrReady` UPDATE against live Postgres.
 *
 * Proves the "direct build stuck RUNNING" symptom is fixed at runtime: after the finalize turn ends, the
 * `jobs` row flips `status: running → done` with `pr_url`/`pr_number` recorded and `pr_state: 'open'` —
 * all without the 30-min reconciler.
 */
const TEAM_ID = '44444444-4444-4444-8444-444444444444'; // sentinel org uuid
const PROJECT_SLUG = 'direct-latch-it';
const FEATURE_BRANCH = 'atlas/feature-latch';
const LIVE_BRANCH = 'atlas/live-latch'; // current_branch — the agent checked out mid-build

describe('Direct-build turn-end latch (live Postgres)', () => {
  let app: NestExpressApplication;
  let manager: AgentSessionManager;
  let dataSource: DataSource;
  const fakePr = new FakeGithubPrService();

  const prevSurface = process.env.SURFACE;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(new FakeEngineRunner())
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(fakePr)
      .overrideProvider(JobTitler)
      .useValue(new FakeThreadTitler())
      // The repo resolver is the credentials/git boundary — supply owner/repo + a token so the real
      // `discoverOpenPr` proceeds to the (faked) GitHub PR lookup.
      .overrideProvider(DRIVER_REPO)
      .useValue({
        resolve: async () => ({
          owner: 'acme',
          repo: 'direct-latch',
          defaultBranch: 'main',
          token: 'ghp_test_token',
        }),
      })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    app.enableShutdownHooks();
    await app.init();

    manager = app.get(AgentSessionManager);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    await purge(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) await purge(dataSource);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  it('flips a running direct build to done + records the PR (pr_state=open) on the LIVE branch at turn-end', async () => {
    // Seed org + repo + a RUNNING job with a feature branch and a diverged live (current) branch, plus a
    // sandbox row so the real `findSandbox` resolves.
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'Direct Latch Org', 'direct-latch-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, $2, 'Direct Latch Repo', 'https://github.com/acme/direct-latch.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID, PROJECT_SLUG],
    );
    const repoId = repoRow.id;
    const [jobRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title, status, feature_branch, current_branch)
         VALUES ($1, $2, 'chat', 'direct build', 'running', $3, $4) RETURNING id`,
      [TEAM_ID, repoId, FEATURE_BRANCH, LIVE_BRANCH],
    );
    const jobId = jobRow.id;
    await dataSource.query(
      `INSERT INTO job_sandboxes (org_id, job_id, repo_id, worktree_path, lifecycle)
         VALUES ($1, $2, $3, '/tmp/atlas-latch-wt', 'attached')`,
      [TEAM_ID, jobId, repoId],
    );

    const stimulus: ChatStimulus = {
      kind: 'chat',
      trust: 'trusted',
      id: 'stim-latch-int',
      receivedAt: new Date(),
      orgId: TEAM_ID,
      repoId,
      jobId,
      body: 'finalize',
      author: { id: 'U-OP', displayName: 'Operator' },
      replyRoute: { surfaceId: 'agent', jobRef: jobId },
    };

    // Arm the flag exactly as `finalize_build` does at its ship success return, then run the turn-end latch
    // (what `runChatTurn`'s finally calls once the finalize turn completes).
    (manager as unknown as { directBuildShipPending: Map<string, boolean> }).directBuildShipPending.set(
      jobId,
      true,
    );

    // Pre-condition: still running, no PR recorded.
    const before = await readJob(dataSource, jobId);
    expect(before.status).toBe('running');
    expect(before.pr_url).toBeNull();

    await (
      manager as unknown as { latchDirectBuildAtTurnEnd: (s: ChatStimulus) => Promise<void> }
    ).latchDirectBuildAtTurnEnd(stimulus);

    // The REAL setPrReady UPDATE landed in live Postgres.
    const after = await readJob(dataSource, jobId);
    expect(after.status).toBe('done');
    expect(after.pr_state).toBe('open');
    expect(after.pr_url).toMatch(/github\.com\/acme\/direct-latch\/pull\/\d+/);
    expect(after.pr_number).not.toBeNull();

    // The PR was discovered by the LIVE (current) branch, not the host-named feature branch.
    expect(fakePr.opened.some((o) => (o.args as { head?: string }).head === LIVE_BRANCH)).toBe(true);
    expect(fakePr.opened.some((o) => (o.args as { head?: string }).head === FEATURE_BRANCH)).toBe(false);

    // The latch only records the PR + flips status. The flag was consumed — a subsequent turn-end must
    // not re-latch.
    expect(
      (manager as unknown as { directBuildShipPending: Map<string, boolean> }).directBuildShipPending.has(
        jobId,
      ),
    ).toBe(false);
  }, 60_000);
});

async function readJob(
  ds: DataSource,
  jobId: string,
): Promise<{ status: string; pr_url: string | null; pr_number: number | null; pr_state: string | null }> {
  const [row] = await ds.query(
    `SELECT status, pr_url, pr_number, pr_state FROM jobs WHERE id = $1`,
    [jobId],
  );
  return row;
}

async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM job_sandboxes WHERE org_id = $1`);
  await q(`DELETE FROM jobs WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
