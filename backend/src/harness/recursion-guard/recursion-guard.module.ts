import { CreateModule } from '@workspace/nestjs-core';
import { LlmModule } from '../llm/llm.module';
import { RecursionGuardService } from './recursion-guard.service';
import { ToolLoopGuardService } from './tool-loop-guard.service';

/**
 * The loop-detection circuit breakers driving the turn graph:
 *  - `RecursionGuardService` — a Haiku rolling-window check over a bot's SPOKEN messages that
 *    detects conversational no-progress repetition (the turn-entry `loop_guard` node).
 *  - `ToolLoopGuardService` — a Haiku check over a single bot repeatedly calling the SAME tool
 *    INSIDE the `llm ⇄ tools` loop (the `tool_loop_guard` node).
 *
 * Modelled on GateModule (`imports: [LlmModule], services: [...]`). EnvService is provided
 * globally by the app's config module — no explicit import needed here.
 */
@CreateModule({
  imports: [LlmModule],
  services: [RecursionGuardService, ToolLoopGuardService],
})
export class RecursionGuardModule {}
