import { Module } from '@nestjs/common';
import { RedisModule } from '../_lib/redis/redis.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ClusterModule } from './cluster/cluster.module';
import { PromptKitModule } from './prompt-kit/prompt-kit.module';
import { ThreadKindModule } from './thread-kind/thread-kind.module';
import { ThreadGroupKindModule } from './thread-group-kind/thread-group-kind.module';
import { AuthModule } from './auth/auth.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { McpModule } from './mcp/mcp.module';
import { ConventionsModule } from './conventions/conventions.module';
import { SkillsModule } from './skills/skills.module';
import { WorkspaceProfileModule } from './workspace-profile/workspace-profile.module';
import { OrgModule } from './org/org.module';
import { TitlingModule } from './titling/titling.module';
import { JobDependencyModule } from './job-deps/job-dependency.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { HostStatsModule } from './host-stats/host-stats.module';
import { CaddyModule } from './exposure/caddy.module';
import { ExposureModule } from './exposure/exposure.module';
import { RealtimeModule } from './realtime/realtime.module';
import { LiveTurnModule } from './surface/live-turn.module';
import { SurfaceModule } from './surface/surface.module';
import { RunnerModule } from './runner/runner.module';
import { MemoryModule } from './memory/memory.module';
import { StimulusModule } from './stimulus/stimulus.module';
import { IngressModule } from './ingress/ingress.module';
import { DecisionGateModule } from './decision-gate/decision-gate.module';
import { AutoFixModule } from './autofix/autofix.module';
import { BrainGatewayModule } from './brain-gateway/brain-gateway.module';
import { DriverApprovalGatewayModule } from './driver-approval-gateway/driver-approval-gateway.module';
import { BrainModule } from './brain/brain.module';
import { DriverModule } from './driver/driver.module';
import { LiveVerificationModule } from './driver/live-verification.module';

/**
 * Atlas v2 APP layer — the composition seam for the edge and the local execution substrate:
 *  - `SurfaceModule` — the thread-aware `ChatSurface` (web SSE/REST in prod, agent in tests) = CHAT_SURFACE;
 *  - `RunnerModule` — the local turn-runner + engine + git substrates (host-only, daemon-free);
 *  - `MemoryModule` — the pgvector semantic-memory primitives;
 *  - `StimulusModule` (W2) — the intake seam: both edges (chat + notification) converge into one
 *    `Stimulus` currency here; mechanical dedup/rate-limit on events; notification-seeds-a-thread; the
 *    chat bridge (subscribes `CHAT_SURFACE.inbound$` → a typed `Message`). A logging no-op consumer is
 *    bound until W3 plugs in real triage;
 *  - `IngressModule` (W2) — the GitHub webhook HTTP edge: `NotificationSource` adapter + controllers
 *    (`POST /webhooks/github/events` → route to owning job, `POST /webhooks/github/state` → silent PR-state sync).
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
    ThreadGroupKindModule,
    AnalyticsModule,
    AuthModule,
    OnboardingModule,
    McpModule,
    ConventionsModule,
    SkillsModule,
    WorkspaceProfileModule,
    OrgModule,
    TitlingModule,
    JobDependencyModule,
    SandboxModule,
    HostStatsModule,
    CaddyModule,
    ExposureModule,
    RealtimeModule,
    LiveTurnModule,
    SurfaceModule,
    RunnerModule,
    MemoryModule,
    StimulusModule,
    IngressModule,
    DecisionGateModule,
    AutoFixModule,
    BrainGatewayModule,
    DriverApprovalGatewayModule,
    BrainModule,
    DriverModule,
    LiveVerificationModule,
  ],
})
export class FeaturesModule {}
