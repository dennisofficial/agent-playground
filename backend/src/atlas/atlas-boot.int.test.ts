import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach } from 'vitest';
import { AgentChatSurface } from './agent-surface';
import { AtlasModule } from './atlas.module';
import {
  ConversationalBrainService,
  DecisionApprovalService,
  JOB_DISPATCHER,
  TriageService,
  type JobDispatcher,
} from './brain';
import { SectionDriver } from './driver';
import { GithubIngressController, WebhookIngressController } from './ingress';
import { STIMULUS_CONSUMER, StimulusIntake, type StimulusConsumer } from './stimulus';
import { AtlasSlackSurface, CHAT_SURFACE, type ChatSurface } from './surface';
import { TestBridgeController } from './test-bridge';

/**
 * BOOT SMOKE for the W2 HTTP composition root. Boots the SAME `AtlasModule` via the SAME path
 * `atlas-main.ts` uses (`NestFactory.create` with `rawBody: true`) and `init()`s the whole DI graph
 * against live Postgres — catching any DI wiring error before it ships. (W1's gate shipped a DI bug
 * because the agent only typechecked and never booted its root; this is the guard against repeating
 * that.)
 *
 * It verifies the graph resolves end-to-end: the intake seam, both ingress controllers (with their
 * per-gateway adapters + the routing/store deps injected), and that the Express HTTP server stands up.
 * Then it closes cleanly. The Slack surface is inert without a token (no socket), so no real Slack is
 * needed; the chat bridge's `onApplicationBootstrap` connect is a safe no-op.
 */
describe('AtlasModule HTTP boot (full DI assembly, live Postgres)', () => {
  it('boots the real composition root via NestFactory.create({ rawBody: true }), resolves the W2 graph, and closes', async () => {
    // Silence the boot banners; we only care that init() doesn't throw.
    const app = await NestFactory.create<NestExpressApplication>(AtlasModule, {
      logger: false,
      rawBody: true,
      abortOnError: false,
    });
    app.enableShutdownHooks();
    await app.init();

    // The intake seam + both ingress controllers resolved — proves the W2 wiring (adapters →
    // routing → store → intake → consumer) is DI-complete.
    expect(app.get(StimulusIntake)).toBeDefined();
    expect(app.get(GithubIngressController)).toBeDefined();
    expect(app.get(WebhookIngressController)).toBeDefined();

    // W3 brain services resolved — proves the brain graph (LLM port, store, classifier + memory deps)
    // is DI-complete, the guard against shipping a typecheck-only DI bug.
    const triage = app.get(TriageService);
    expect(triage).toBeDefined();
    expect(app.get(ConversationalBrainService)).toBeDefined();
    expect(app.get(DecisionApprovalService)).toBeDefined();

    // The INPUT seam: STIMULUS_CONSUMER is the brain's triage (NOT W2's logging no-op).
    const consumer = app.get<StimulusConsumer>(STIMULUS_CONSUMER);
    expect(consumer).toBe(triage);

    // The OUTPUT seam: JOB_DISPATCHER resolves to W4's real SectionDriver (the no-op is OVERRIDDEN —
    // BrainModule no longer binds it; DriverModule's @Global useExisting: SectionDriver wins). This is
    // the exact DI-wiring guard a prior workstream's typecheck-only ship missed.
    const driver = app.get(SectionDriver);
    expect(driver).toBeDefined();
    expect(app.get<JobDispatcher>(JOB_DISPATCHER)).toBe(driver);

    // W6: default (no ATLAS_SURFACE) binds the real Slack adapter as CHAT_SURFACE.
    expect(app.get<ChatSurface>(CHAT_SURFACE)).toBe(app.get(AtlasSlackSurface));

    // The HTTP routes are registered (the notification HTTP edge the headless context lacked).
    const server = app.getHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, (err?: Error) => (err ? reject(err) : resolve()));
    });
    const routes = collectRoutePaths(app);
    expect(routes).toContain('/ingress/github');
    expect(routes).toContain('/ingress/webhook');

    await app.close();
  }, 60_000);
});

/**
 * W6 — booting the SAME composition root with ATLAS_SURFACE=agent binds the in-process
 * `AgentChatSurface` as the `CHAT_SURFACE` (no Slack), with no DI errors. This is the mode W9 boots in
 * to drive the brain → driver → PR flow programmatically.
 */
describe('AtlasModule boot with ATLAS_SURFACE=agent (the programmatic surface)', () => {
  const prev = process.env.ATLAS_SURFACE;
  afterEach(() => {
    if (prev === undefined) delete process.env.ATLAS_SURFACE;
    else process.env.ATLAS_SURFACE = prev;
  });

  it('binds AgentChatSurface as CHAT_SURFACE and resolves the whole graph', async () => {
    process.env.ATLAS_SURFACE = 'agent';
    const app = await NestFactory.create<NestExpressApplication>(AtlasModule, {
      logger: false,
      rawBody: true,
      abortOnError: false,
    });
    app.enableShutdownHooks();
    await app.init();

    const agent = app.get(AgentChatSurface);
    expect(agent).toBeDefined();
    // The active CHAT_SURFACE the brain/driver/bridge inject is the agent one (NOT Slack).
    const bound = app.get<ChatSurface>(CHAT_SURFACE);
    expect(bound).toBe(agent);
    expect(bound.name).toBe('agent');

    // The brain + dispatcher still resolve — the surface swap doesn't disturb the rest of the graph.
    expect(app.get(TriageService)).toBeDefined();
    expect(app.get(SectionDriver)).toBeDefined();

    await app.close();
  }, 60_000);
});

/**
 * The dev/test HTTP test-bridge (`POST /test/*`): booting with ATLAS_SURFACE=agent + ATLAS_TEST_BRIDGE=on
 * resolves the controller (its `AgentChatSurface` + `DecisionApprovalService` + repo deps are DI-complete)
 * and registers every `/test/*` route on the Express server. This is the same DI-wiring guard W1 missed
 * — typecheck alone wouldn't catch a bad injection here.
 */
describe('AtlasModule boot with the test-bridge (ATLAS_TEST_BRIDGE=on)', () => {
  const prevSurface = process.env.ATLAS_SURFACE;
  const prevBridge = process.env.ATLAS_TEST_BRIDGE;
  afterEach(() => {
    if (prevSurface === undefined) delete process.env.ATLAS_SURFACE;
    else process.env.ATLAS_SURFACE = prevSurface;
    if (prevBridge === undefined) delete process.env.ATLAS_TEST_BRIDGE;
    else process.env.ATLAS_TEST_BRIDGE = prevBridge;
  });

  it('resolves TestBridgeController and registers the /test/* routes', async () => {
    process.env.ATLAS_SURFACE = 'agent';
    process.env.ATLAS_TEST_BRIDGE = 'on';
    const app = await NestFactory.create<NestExpressApplication>(AtlasModule, {
      logger: false,
      rawBody: true,
      abortOnError: false,
    });
    app.enableShutdownHooks();
    await app.init();

    // The controller resolves — its AgentChatSurface + DecisionApprovalService + repo deps are wired.
    expect(app.get(TestBridgeController)).toBeDefined();

    const server = app.getHttpServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, (err?: Error) => (err ? reject(err) : resolve()));
    });
    const routes = collectRoutePaths(app);
    expect(routes).toContain('/test/seed');
    expect(routes).toContain('/test/say');
    expect(routes).toContain('/test/approve');
    expect(routes).toContain('/test/job');
    expect(routes).toContain('/test/thread');

    await app.close();
  }, 60_000);
});

/** Walk the Express router (recursing into nested routers) for the registered route paths. */
function collectRoutePaths(app: NestExpressApplication): string[] {
  const instance = app.getHttpAdapter().getInstance() as {
    _router?: { stack?: RouterLayer[] };
    router?: { stack?: RouterLayer[] };
  };
  const paths: string[] = [];
  walk(instance._router?.stack ?? instance.router?.stack ?? [], paths);
  return paths;
}

interface RouterLayer {
  route?: { path?: string };
  handle?: { stack?: RouterLayer[] };
}

function walk(stack: RouterLayer[], out: string[]): void {
  for (const layer of stack) {
    if (layer.route?.path) out.push(layer.route.path);
    if (layer.handle?.stack) walk(layer.handle.stack, out);
  }
}
