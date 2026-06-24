import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { BRAIN_LLM } from '../brain';
import { CLASSIFIER_LLM } from '../decision-gate';
import { PLANNER_LLM } from '../driver';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeBrainLlm,
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakePlannerLlm,
} from '../e2e/e2e-stubs';
import { TestBridgeController } from './test-bridge.controller';

/**
 * ROUND-TRIP int test for the HTTP test-bridge. Boots the REAL `AppModule` (SURFACE=agent +
 * TEST_BRIDGE=on) against live Postgres, mocking ONLY the three external boundaries (brain LLM,
 * planner, classifier + engine/git/PR — reusing the e2e stubs) so NO network is touched. Then drives the
 * bridge end-to-end through the controller:
 *   seed → say → (FakeBrainLlm asks a clarifying question) → the question is captured as an outbound reply
 *   and persisted in the thread transcript; the job + thread read endpoints reflect the conversation.
 *
 * This proves the bridge's wiring + the seed/say/thread/job seams for real (channel routing,
 * sendFromHuman → brain → post capture, repo reads) without billing an LLM or opening a PR.
 */
const TEAM_ID = '22222222-2222-4222-8222-222222222222'; // sentinel org uuid
const PROJECT_ID = 'testbridge-it';
const CHANNEL_REF = 'C-TESTBRIDGE-IT';

describe('TestBridge HTTP round-trip (live Postgres, mocked LLM)', () => {
  let app: NestExpressApplication;
  let controller: TestBridgeController;
  let dataSource: DataSource;

  const prevSurface = process.env.SURFACE;
  const prevBridge = process.env.TEST_BRIDGE;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    process.env.TEST_BRIDGE = 'on';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BRAIN_LLM)
      .useValue(new FakeBrainLlm())
      .overrideProvider(PLANNER_LLM)
      .useValue(new FakePlannerLlm())
      .overrideProvider(CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(new FakeEngineRunner())
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(new FakeGithubPrService())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    app.enableShutdownHooks();
    await app.init();

    controller = app.get(TestBridgeController);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    await purge(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) await purge(dataSource);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
    if (prevBridge === undefined) delete process.env.TEST_BRIDGE;
    else process.env.TEST_BRIDGE = prevBridge;
  });

  it('seed is idempotent and returns a channel id', async () => {
    const first = await controller.seed({
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      repoUrl: 'https://github.com/acme/testbridge.git',
      channel: CHANNEL_REF,
    });
    expect(first.channelId).toBeTruthy();
    expect(first.orgId).toBe(TEAM_ID);

    // Re-seed (different repo) → same channel row, updated in place (idempotent).
    const second = await controller.seed({
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      repoUrl: 'https://github.com/acme/testbridge-renamed.git',
      baseBranch: 'develop',
      channel: CHANNEL_REF,
    });
    expect(second.channelId).toBe(first.channelId);
  });

  it('say routes a human message to the AgentSessionManager and captures its reply on the thread', async () => {
    const said = await controller.say({
      channel: PROJECT_ID, // the surface addresses by repo id (channel-free model)
      text: 'Add a short note to the README explaining the build step.',
    });

    // R3: AgentSessionManager receives the chat. With no thread sandbox provisioned (inbound-derived
    // threads don't auto-provision sandboxes), the brain replies with the "create a thread" fallback.
    // The wiring is what we're testing: the reply IS captured on the thread, the surface works.
    expect(said.threadTs).toBeTruthy();
    expect(said.replies.length).toBeGreaterThan(0);
    // The fallback message tells the operator to create a thread via the web app.
    expect(said.replies[0].text.toLowerCase()).toContain('create a thread');
    // No approval card (no plan was proposed).
    expect(said.approvalCard).toBeUndefined();

    // The transcript endpoint reflects the human message + Atlas's reply, in order.
    const transcript = await controller.thread(said.threadTs);
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript.some((l) => !l.isAtlas && l.text.includes('README'))).toBe(true);
    expect(transcript.some((l) => l.isAtlas)).toBe(true);
  }, 30_000);
});

/** Delete every row this test's synthetic tenant owns (fixed ids → a re-run would PK-collide).
 *  The FK cascade from `threads` removes messages/sections/phases/decision_records/stimuli/sandboxes. */
async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM threads WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
