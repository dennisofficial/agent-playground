import { CreateModule } from '@workspace/nestjs-core';
import { LlmModule } from '../llm/llm.module';
import { RecursionGuardService } from './recursion-guard.service';

/**
 * The loop-detection circuit breaker: a Haiku rolling-window check over a bot's recent messages
 * that detects no-progress repetition and drives the `guard` node in the turn graph.
 *
 * Modelled on GateModule (`imports: [LlmModule], services: [...]`). EnvService is provided
 * globally by the app's config module — no explicit import needed here.
 */
@CreateModule({
  imports: [LlmModule],
  services: [RecursionGuardService],
})
export class RecursionGuardModule {}
