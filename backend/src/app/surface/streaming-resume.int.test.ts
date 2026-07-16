import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../app.module';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '@shared/engine';
import type { RunEngineArgs, EngineRunResult } from '@shared/engine/engine.types';
import { GithubPrService, LocalGitService } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import { SANDBOX_PROVIDER } from '../sandbox';
import { RedisEngineRunner } from '../sandbox/redis-engine-runner';
import { AgentChatSurface } from '../agent-surface';
import { LiveTurnStore } from './live-turn-store';
import { WebSurfaceController } from './web-surface.controller';
import {
  FakeClassifierLlm,
  FakeGithubPrService,
  FakeLocalGitService,
} from '../e2e/e2e-stubs';

/**
 * FULL-APP E2E for RESUMABLE/DURABLE streaming. Boots the REAL `AppModule` (SURFACE=agent) with the
 * external boundaries faked, drives a real human message through the WHOLE pipeline
 * (intake → router → AgentSessionManager → lazy provisioning → engine turn), and proves:
 *
 *   1. The brain provisions on the first turn and streams engine events into `LiveTurnStore`.
 *   2. MID-TURN, a (re)connecting client resumes: `LiveTurnStore.snapshot` + the SSE controller's
 *      snapshot-on-connect reflect the partial in-flight response — so a long answer keeps streaming
 *      across a refresh/reconnect instead of going dark.
 *   3. On completion the durable transcript (`messages`) holds the assembled blocks and the live buffer
 *      is cleared.
 *
 * The fake engine PAUSES mid-turn (a deferred the test releases) so we can observe the in-flight state.
 */

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const REPO_SLUG = 'streaming-resume-it';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake in-sandbox engine that streams a few tokens, PAUSES, then finishes — so we can peek mid-turn. */
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
      // The brain injects ENGINE_RUNNER (= `useExisting: RedisEngineRunner`), so the streaming fake must be
      // bound to ENGINE_RUNNER directly — overriding RedisEngineRunner alone is bypassed by any ENGINE_RUNNER
      // override and the brain would otherwise get the wrong runner.
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
    await ds
      .query(`DELETE FROM jobs WHERE org_id = $1`, [ORG_ID])
      .catch(() => undefined);
    await ds
      .query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID])
      .catch(() => undefined);
    await ds
      .query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID])
      .catch(() => undefined);
  }

  afterAll(async () => {
    runner?.release.resolve(); // never leave the turn hanging
    await purge().catch(() => undefined);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  it('resumes an in-flight turn on (re)connect, then persists the durable transcript on completion', async () => {
    // Drive a real human message — fire-and-forget; the brain turn runs async (producer ≠ connection).
    surface.sendFromHuman(repoId, 'Say hello', {
      orgId: ORG_ID,
      threadTs: jobId,
      authorId: 'U',
      authorName: 'Op',
    });

    // Wait until the turn has streamed a couple of tokens and is paused mid-flight.
    await runner.reachedMid.promise;
    await new Promise((r) => setTimeout(r, 20)); // let the push microtasks settle

    // (1) RESUMABLE — the in-flight cumulative state is in the store (what a reconnecting client gets).
    const snap = liveTurns.snapshot(repoId, jobId);
    expect(snap).not.toBeNull();
    expect(snap!.active).toBe(true);
    expect(snap!.blocks.find((b) => b.kind === 'text')).toMatchObject({
      text: 'Hello',
      done: false,
    });

    // (1b) NO double-render: the in-flight content is NOT yet in the durable log (it's persisted only at
    // turn end). If it were persisted mid-turn, a reconnecting client would see it twice — once from
    // `/messages` and once from the live snapshot.
    const midRows = await ds.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND text LIKE '%Hello world%'`,
      [jobId],
    );
    expect(midRows[0].n).toBe(0);

    // (2) A client that connects NOW (e.g. after a refresh) replays that snapshot the instant it subscribes.
    const frames: Array<Record<string, unknown>> = [];
    const sub = controller
      .events(ORG_ID, repoId)
      .subscribe((m: MessageEvent) =>
        frames.push(m.data as Record<string, unknown>),
      );
    const snapshotFrame = frames.find(
      (f) =>
        f.type === 'stream' &&
        (f.event as { kind?: string }).kind === 'snapshot',
    );
    expect(snapshotFrame).toBeDefined();
    expect(
      (snapshotFrame!.event as { blocks: Array<{ text?: string }> }).blocks[0]
        .text,
    ).toBe('Hello');

    // Release the turn → it finishes and persists.
    runner.release.resolve();

    // (3) DURABLE — the assembled transcript lands in `messages`; the live buffer clears.
    await waitFor(async () => {
      const rows = await ds.query(
        `SELECT text, kind FROM transcript_messages WHERE job_id = $1 AND author_bot_id IS NOT NULL`,
        [jobId],
      );
      return rows.some(
        (r: { text: string; kind: string }) =>
          r.kind === 'chat' && r.text === 'Hello world',
      );
    });
    expect(liveTurns.snapshot(repoId, jobId)).toBeNull();

    // The late subscriber also saw the turn_end marker (its cue to reconcile against /messages).
    expect(
      frames.some(
        (f) =>
          f.type === 'stream' &&
          (f.event as { kind?: string }).kind === 'turn_end',
      ),
    ).toBe(true);
    sub.unsubscribe();
  }, 30_000);
});

/** Poll a predicate until true or timeout. */
async function waitFor(
  pred: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
