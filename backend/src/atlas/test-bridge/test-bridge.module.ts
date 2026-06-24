import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasJob,
  AtlasMessage,
  AtlasRepo,
  Organization,
} from '../persistence/entities';
import { TestBridgeController } from './test-bridge.controller';

/**
 * The Atlas v2 HTTP TEST-BRIDGE — a dev/test-only edge (`POST /test/*`) for driving a real conversation
 * with a running Atlas. ALWAYS imported by `AppModule`, but every endpoint 404s unless `ATLAS_TEST_BRIDGE
 * =on` (the controller's `assertEnabled()` gate) — so registering the module unconditionally is safe
 * (the controller is inert without the flag) and keeps the wiring trivially testable.
 *
 * It needs `AgentChatSurface` (from the @Global `SurfaceModule`'s `AgentSurfaceModule`) and
 * `DecisionApprovalService` (from the @Global `BrainModule`) — both resolve ambiently — plus the
 * `atlas_*` repos it reads/writes directly, registered here on the 'atlas' connection. Zero v1 imports.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Organization, AtlasRepo, AtlasChannel, AtlasJob, AtlasMessage],
      ATLAS_CONNECTION,
    ),
  ],
  controllers: [TestBridgeController],
})
export class TestBridgeModule {}
