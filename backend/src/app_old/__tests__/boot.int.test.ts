import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach } from 'vitest';
import { AppOldModule } from '../app-v1.module';
import { StimulusIntake } from '../stimulus/stimulus-intake.service';
import { GithubEventsWebhookController, GithubStateWebhookController } from '../ingress/github-webhook.controller';
import { AgentSessionManager } from '../brain/agent-session-manager.service';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import { BRAIN_SINK, BrainSink } from '../stimulus/stimulus-consumer';
import { ThreadDriver } from '../driver/thread-driver.service';
import { JOB_DISPATCHER, JobDispatcher } from '../brain/job-dispatcher';
import { CHAT_SURFACE, ChatSurface } from '../surface/chat-surface.port';
import { WebSurface } from '../surface/web-surface';
import { AgentChatSurface } from '../agent-surface/agent-chat-surface';

describe('AppModule HTTP boot (full DI assembly, live Postgres)', () => {
  it('boots the real composition root via NestFactory.create({ rawBody: true }), resolves the W2 graph, and closes', async () => {
    const prevSurface = process.env.SURFACE;
    delete process.env.SURFACE;
    let app: NestExpressApplication | undefined;
    try {
      app = await NestFactory.create<NestExpressApplication>(AppOldModule, {
        logger: false,
        rawBody: true,
        abortOnError: false,
      });
      app.enableShutdownHooks();
      await app.init();

      expect(app.get(StimulusIntake)).toBeDefined();
      expect(app.get(GithubEventsWebhookController)).toBeDefined();
      expect(app.get(GithubStateWebhookController)).toBeDefined();

      expect(app.get(AgentSessionManager)).toBeDefined();
      expect(app.get(DecisionApprovalService)).toBeDefined();

      const sink = app.get<BrainSink>(BRAIN_SINK);
      expect(typeof sink.handleChat).toBe('function');
      expect(typeof sink.deliverEvent).toBe('function');

      const driver = app.get(ThreadDriver);
      expect(driver).toBeDefined();
      expect(app.get<JobDispatcher>(JOB_DISPATCHER)).toBe(driver);

      const boundDefault = app.get<ChatSurface>(CHAT_SURFACE);
      expect(boundDefault).toBe(app.get(WebSurface));
      expect(boundDefault.name).toBe('web');

      const server = app.getHttpServer();
      await new Promise<void>((resolve, reject) => {
        server.listen(0, (err?: Error) => (err ? reject(err) : resolve()));
      });
      const routes = collectRoutePaths(app);
      expect(routes).toContain('/webhooks/github/events');
      expect(routes).toContain('/webhooks/github/state');
    } finally {
      await app?.close();
      if (prevSurface === undefined) delete process.env.SURFACE;
      else process.env.SURFACE = prevSurface;
    }
  }, 60_000);
});

describe('AppModule boot with SURFACE=agent (the programmatic surface)', () => {
  const prev = process.env.SURFACE;
  afterEach(() => {
    if (prev === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prev;
  });

  it('binds AgentChatSurface as CHAT_SURFACE and resolves the whole graph', async () => {
    process.env.SURFACE = 'agent';
    const app = await NestFactory.create<NestExpressApplication>(AppOldModule, {
      logger: false,
      rawBody: true,
      abortOnError: false,
    });
    app.enableShutdownHooks();
    await app.init();

    const agent = app.get(AgentChatSurface);
    expect(agent).toBeDefined();
    const bound = app.get<ChatSurface>(CHAT_SURFACE);
    expect(bound).toBe(agent);
    expect(bound.name).toBe('agent');

    expect(app.get(AgentSessionManager)).toBeDefined();
    expect(app.get(ThreadDriver)).toBeDefined();

    await app.close();
  }, 60_000);
});

describe('AppModule boot with the test-bridge (TEST_BRIDGE=on)', () => {
  const prevSurface = process.env.SURFACE;
  const prevBridge = process.env.TEST_BRIDGE;
  afterEach(() => {
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
    if (prevBridge === undefined) delete process.env.TEST_BRIDGE;
    else process.env.TEST_BRIDGE = prevBridge;
  });

  it('resolves TestBridgeController and registers the /test/* routes', async () => {
    process.env.SURFACE = 'agent';
    process.env.TEST_BRIDGE = 'on';
    const app = await NestFactory.create<NestExpressApplication>(AppOldModule, {
      logger: false,
      rawBody: true,
      abortOnError: false,
    });
    app.enableShutdownHooks();
    await app.init();

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
