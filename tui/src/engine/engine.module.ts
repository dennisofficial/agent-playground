import { Module } from "@nestjs/common";
import { ClaudeEngineService } from "./claude-engine.service.js";
import { claudeSdkProvider } from "./claude-sdk.provider.js";
import { ClaudeNormaliserService } from "./normalise/claude-normaliser.service.js";
import { RawTapeService } from "./raw-tape.service.js";

@Module({
  providers: [
    claudeSdkProvider,
    ClaudeNormaliserService,
    RawTapeService,
    ClaudeEngineService,
  ],
  exports: [ClaudeEngineService, ClaudeNormaliserService, RawTapeService],
})
export class EngineModule {}
