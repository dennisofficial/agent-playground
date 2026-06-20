import { EnvService } from '@core/config/env/env.service';
import { Module } from '@nestjs/common';
import {
  ATLAS_CLASSIFIER_LLM,
  AnthropicClassifierLlm,
} from './classifier-llm';
import { DecisionClassifier } from './decision-classifier.service';
import { ParkAndAskService } from './park-and-ask.service';
import { PlanVisibilityService } from './plan-visibility.service';

/**
 * W5 — the DECISION-CLASS GATE module. Bundles the three W5 services so W4's section driver can import
 * one module:
 *   - `DecisionClassifier` — always-ask / never-ask / covered classification (rules + LLM fallback);
 *   - `ParkAndAskService` — park a section & ask in-thread, resolve on the human's reply;
 *   - `PlanVisibilityService` — post a section's plan for non-blocking visibility.
 *
 * The classifier's ambiguous-case LLM is bound behind `ATLAS_CLASSIFIER_LLM` (a cheap Haiku call off
 * `ANTHROPIC_API_KEY` / `GATE_MODEL`, no new env var; key-less → returns undefined → gate defaults to
 * ask). `CHAT_SURFACE` is provided @Global by `SurfaceModule` (which the composing root imports), so it
 * resolves without importing it here.
 *
 * NOT YET WIRED into the app — the orchestrator (W9) imports this module into the Atlas composition
 * root. Zero v1 imports.
 */
@Module({
  providers: [
    {
      provide: ATLAS_CLASSIFIER_LLM,
      inject: [EnvService],
      useFactory: (env: EnvService) =>
        new AnthropicClassifierLlm(
          () => env.get('ANTHROPIC_API_KEY'),
          () => env.get('GATE_MODEL'),
        ),
    },
    DecisionClassifier,
    ParkAndAskService,
    PlanVisibilityService,
  ],
  exports: [
    DecisionClassifier,
    ParkAndAskService,
    PlanVisibilityService,
    ATLAS_CLASSIFIER_LLM,
  ],
})
export class DecisionGateModule {}
