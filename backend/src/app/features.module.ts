import { Module } from '@nestjs/common';
import { RedisModule } from '../_lib/redis/redis.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth';
import { ClusterModule } from './cluster';
import { AutoFixModule } from './autofix';
import { BrainModule } from './brain';
import { DecisionGateModule } from './decision-gate';
import { DriverModule } from './driver';
import { IngressModule } from './ingress';
import { RunnerModule } from './runner';
import { SandboxModule } from './sandbox';
import { StimulusModule } from './stimulus';
import { LiveTurnModule, SurfaceModule } from './surface';
import { MemoryModule } from './memory';
import { OnboardingModule } from './onboarding';
import { OrgModule } from './org';
import { RealtimeModule } from './realtime';
import { TicketsModule } from './tickets';
import { TitlingModule } from './titling';
import { TestBridgeModule } from './test-bridge';
import { PromptKitModule } from './prompt-kit';
import { ThreadKindModule } from './thread-kind';

/**
 * Atlas v2 APP layer — the composition seam for the edge and the local execution substrate:
 *  - `SurfaceModule` — the thread-aware `ChatSurface` (web SSE/REST in prod, agent in tests) = CHAT_SURFACE;
 *  - `RunnerModule` — the local turn-runner + engine + git substrates (host-only, daemon-free);
 *  - `MemoryModule` — the pgvector semantic-memory primitives;
 *  - `StimulusModule` (W2) — the intake seam: both edges (chat + notification) converge into one
 *    `Stimulus` currency here; mechanical dedup/rate-limit on events; notification-seeds-a-thread; the
 *    chat bridge (subscribes `CHAT_SURFACE.inbound$` → `ChatStimulus`). A logging no-op consumer is
 *    bound until W3 plugs in real triage;
 *  - `IngressModule` (W2) — the HTTP edge: per-gateway `NotificationSource` adapters + controllers
 *    (`POST /ingress/github`, `POST /ingress/webhook`).
 *  - `BrainModule` (W3) — the brain: the `BRAIN_SINK` binding (chat → its session, event → a harness-message delivery), the
 *    conversational grill, the decision-record approval gate. It injects `JOB_DISPATCHER` (bound by W4).
 *  - `DriverModule` (W4) — the deterministic, resumable thread/step driver. Binds the REAL
 *    `JOB_DISPATCHER` (`useExisting: ThreadDriver`, @Global), so the brain's dispatch reaches the driver
 *    with zero changes; consumes W5 (gate), W7 (auto-fix), and W1 (runner/git). Reconciles in-flight jobs
 *    on boot.
 *
 * The agent-facing programmatic surface lands in W6. It is deliberately SEPARATE from v1's `slack-app`
 * — Atlas owns its own ingress and binds NOTHING from `@harness/**`.
 *
 * `TestBridgeModule` is a DEV/TEST-only HTTP edge (`POST /test/*`) — always imported, but inert (every
 * endpoint 404s) unless `TEST_BRIDGE=on`, so it never affects prod.
 */
@Module({
  imports: [
    RedisModule,
    ClusterModule,
    PromptKitModule,
    ThreadKindModule,
    AnalyticsModule,
    AuthModule,
    OnboardingModule,
    OrgModule,
    TitlingModule,
    TicketsModule,
    SandboxModule,
    RealtimeModule,
    LiveTurnModule,
    SurfaceModule,
    RunnerModule,
    MemoryModule,
    StimulusModule,
    IngressModule,
    DecisionGateModule,
    AutoFixModule,
    BrainModule,
    DriverModule,
    TestBridgeModule,
  ],
})
export class FeaturesModule {}
