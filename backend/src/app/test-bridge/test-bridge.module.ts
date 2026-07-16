import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobBootstrapModule } from '../job-bootstrap';
import {
  TranscriptMessageEntity,
  RepoEntity,
  JobEntity,
  OrganizationEntity,
  ThreadEntity,
  ActiveTurnEntity,
  InboundMessageEntity,
} from '../persistence/entities';
import { TestBridgeController } from './test-bridge.controller';

/**
 * The Atlas v2 HTTP TEST-BRIDGE — a dev/test-only edge (`POST /test/*`) for driving a real conversation
 * with a running Atlas. ALWAYS imported by `FeaturesModule`, but every endpoint 404s in production
 * (the controller's `assertEnabled()` gate — a hard NODE_ENV floor, not a flag) — so registering the
 * module unconditionally is safe and keeps the wiring trivially testable.
 *
 * It needs `AgentChatSurface` (from the @Global `SurfaceModule`'s `AgentSurfaceModule`) and
 * `DecisionApprovalService` (from the @Global `BrainModule`) — both resolve ambiently — plus the
 * `app` repos it reads/writes directly, registered here on the 'app' connection. Zero v1 imports.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [
        OrganizationEntity,
        RepoEntity,
        JobEntity,
        TranscriptMessageEntity,
        ThreadEntity,
        ActiveTurnEntity,
        InboundMessageEntity,
      ],
      DB_CONNECTION,
    ),
    JobBootstrapModule,
  ],
  controllers: [TestBridgeController],
})
export class TestBridgeModule {}
