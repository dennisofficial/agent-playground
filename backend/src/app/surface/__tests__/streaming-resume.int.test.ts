import type { MessageEvent } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import type { EngineRunResult, RunEngineArgs } from '@shared/engine/engine.types';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentChatSurface } from '../../agent-surface/agent-chat-surface';
import { AppModule } from '../../app.module';
import { CLASSIFIER_LLM } from '../../decision-gate/classifier-llm';
import { FakeClassifierLlm, FakeGithubPrService, FakeLocalGitService } from '../../e2e/e2e-stubs';
import { GithubPrService } from '../../git/github-pr.service';
import { LocalGitService } from '../../git/local-git.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { SANDBOX_PROVIDER } from '../../sandbox/sandbox-provider.port';
import { RedisEngineRunner } from '../../sandbox/redis-engine-runner';
import { LiveTurnStore } from '../live-turn-store';
import { WebSurfaceController } from '../web-surface.controller';


const ORG_ID = '33333333-3333-4333-8333-333333333333';
const REPO_SLUG = 'streaming-resume-it';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

class FakeStreamingRunner {
  readonly reachedMid = deferred();
  readonly release = deferred();
  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    args.onEvent?.({ kind: 'session', sessionId: 'sess-stream-1' });
    args.onEvent?.({ kind: 'text_delta', text: 'Hel' });
    args.onEvent?.({ kind: 'text_delta', text: 'lo' });
    this.reachedMid.resolve();
    await this.release.promise; // hold the turn open while the test inspects the resumable snapshot
    args.onEvent?.({ kind: 'text', text: 'Hello world' });
    args.onEvent?.({ kind: 'result', text: 'Hello world' });
    return { result: 'Hello world', sessionId: 'sess-stream-1' };
  }
}

describe('Streaming resume (full AppModule, live Postgres, faked boundaries)', () => {
  let app: Awaited<ReturnType<typeof bootApp>>['app'];
  let ds: DataSource;
  let liveTurns: LiveTurnStore;
  let surface: AgentChatSurface;
  let controller: WebSurfaceController;
  let runner: FakeStreamingRunner;
  let repoId: string;
  let jobId: string;

  const prevSurface = process.env.SURFACE;

  async function bootApp() {
    runner = new FakeStreamingRunner();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(runner)
      .overrideProvider(RedisEngineRunner)
      .useValue(runner)
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue({
        attach: async ({ sandbox }: { sandbox: unknown }) => sandbox,
        teardown: async () => {},
        teardownByIdentity: async () => {},
      })
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(new FakeGithubPrService())
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { app };
  }

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    ({ app } = await bootApp());
    ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    liveTurns = app.get(LiveTurnStore);
    surface = app.get(AgentChatSurface);
    controller = app.get(WebSurfaceController);

    await purge();
    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Stream Org', 'stream-org', 'active')`,
      [ORG_ID],
    );
    const [repo] = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, $2, 'Stream Repo', 'https://github.com/x/stream.git', 'main', NULL, true) RETURNING id`,
      [ORG_ID, REPO_SLUG],
    );
    repoId = repo.id;
    const [thread] = await ds.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title) VALUES ($1, $2, 'chat', 'Stream thread') RETURNING id`,
      [ORG_ID, repoId],
    );
    jobId = thread.id;
  }, 60_000);

  async function purge() {
    await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    await ds.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
    await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
  }

  afterAll(async () => {
    runner?.release.resolve(); // never leave the turn hanging
    await purge().catch(() => undefined);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  it('resumes an in-flight turn on (re)connect, then persists the durable transcript on completion', async () => {
    surface.sendFromHuman(repoId, 'Say hello', {
      orgId: ORG_ID,
      threadTs: jobId,
      authorId: 'U',
      authorName: 'Op',
    });

    await runner.reachedMid.promise;
    await new Promise((r) => setTimeout(r, 20)); // let the push microtasks settle

    const snap = liveTurns.snapshot(repoId, jobId);
    expect(snap).not.toBeNull();
    expect(snap!.active).toBe(true);
    expect(snap!.blocks.find((b) => b.kind === 'text')).toMatchObject({
      text: 'Hello',
      done: false,
    });

    const midRows = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND text LIKE '%Hello world%'`,
      [jobId],
    );
    expect(midRows[0].n).toBe(0);

    const frames: Array<Record<string, unknown>> = [];
    const sub = controller
      .events(ORG_ID, repoId)
      .subscribe((m: MessageEvent) => frames.push(m.data as Record<string, unknown>));
    const snapshotFrame = frames.find(
      (f) => f.type === 'stream' && (f.event as { kind?: string }).kind === 'snapshot',
    );
    expect(snapshotFrame).toBeDefined();
    expect((snapshotFrame!.event as { blocks: Array<{ text?: string }> }).blocks[0].text).toBe(
      'Hello',
    );

    runner.release.resolve();

    await waitFor(async () => {
      const rows = await ds.query(
        `SELECT text, kind FROM transcript_messages WHERE job_id = $1 AND author_bot_id IS NOT NULL`,
        [jobId],
      );
      return rows.some(
        (r: { text: string; kind: string }) => r.kind === 'chat' && r.text === 'Hello world',
      );
    });
    expect(liveTurns.snapshot(repoId, jobId)).toBeNull();

    expect(
      frames.some((f) => f.type === 'stream' && (f.event as { kind?: string }).kind === 'turn_end'),
    ).toBe(true);
    sub.unsubscribe();
  }, 30_000);
});

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
