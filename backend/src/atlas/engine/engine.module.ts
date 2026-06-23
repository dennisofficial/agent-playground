import { Module } from '@nestjs/common';
import { AtlasEsmModule } from './esm.module';

/**
 * The Atlas v2 ENGINE module — provides the lazy ESM SDK tokens used by DockerEngineRunner and
 * EngineCore. The in-process EngineRunner has been removed; all turns now run inside a Docker
 * sandbox container via DockerEngineRunner (wired in SandboxModule). Zero v1 imports.
 */
@Module({
  imports: [AtlasEsmModule],
  providers: [],
  exports: [],
})
export class EngineModule {}
