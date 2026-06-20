import { Module } from '@nestjs/common';
import { AtlasEsmModule } from './esm.module';
import { EngineRunner } from './engine-runner.service';

/**
 * The Atlas v2 ENGINE module — provides the minimal `EngineRunner` (Claude/Codex in plan/execute
 * with credentials + an isolated agent home) and the lazy ESM SDK tokens it needs. Zero v1 imports:
 * the SDKs come from Atlas's own `AtlasEsmModule`, not v1's `_lib/esm`.
 */
@Module({
  imports: [AtlasEsmModule],
  providers: [EngineRunner],
  exports: [EngineRunner],
})
export class EngineModule {}
