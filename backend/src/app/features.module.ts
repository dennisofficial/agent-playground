import { Module } from '@nestjs/common';
import { RedisModule } from '../_lib/redis/redis.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { AutoFixModule } from './autofix/autofix.module';
import { BrainGatewayModule } from './brain-gateway/brain-gateway.module';
import { BrainModule } from './brain/brain.module';
import { ClusterModule } from './cluster/cluster.module';
import { ConventionsModule } from './conventions/conventions.module';
import { DecisionGateModule } from './decision-gate/decision-gate.module';
import { DriverApprovalGatewayModule } from './driver-approval-gateway/driver-approval-gateway.module';
import { DriverModule } from './driver/driver.module';
import { LiveVerificationModule } from './driver/live-verification.module';
import { CaddyModule } from './exposure/caddy.module';
import { ExposureModule } from './exposure/exposure.module';
import { HostStatsModule } from './host-stats/host-stats.module';
import { IngressModule } from './ingress/ingress.module';
import { JobDependencyModule } from './job-deps/job-dependency.module';
import { McpModule } from './mcp/mcp.module';
import { MemoryModule } from './memory/memory.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrgModule } from './org/org.module';
import { PromptKitModule } from './prompt-kit/prompt-kit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RunnerModule } from './runner/runner.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { SkillsModule } from './skills/skills.module';
import { StimulusModule } from './stimulus/stimulus.module';
import { LiveTurnModule } from './surface/live-turn.module';
import { SurfaceModule } from './surface/surface.module';
import { ThreadGroupKindModule } from './thread-group-kind/thread-group-kind.module';
import { ThreadKindModule } from './thread-kind/thread-kind.module';
import { TitlingModule } from './titling/titling.module';
import { WorkspaceProfileModule } from './workspace-profile/workspace-profile.module';

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
