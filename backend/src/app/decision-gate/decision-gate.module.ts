import { Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding';
import { CLASSIFIER_LLM, AnthropicClassifierLlm } from './classifier-llm';
import { DecisionClassifier } from './decision-classifier.service';
import { PlanVisibilityService } from './plan-visibility.service';

/**
 * W5 — the DECISION-CLASS GATE module. Bundles the W5 services so W4's thread driver can import
 * one module:
 *   - `DecisionClassifier` — always-ask / never-ask / covered classification (rules + LLM fallback);
 *     still used by the brain's `start_direct_build` fast-path safety gate;
 *   - `PlanVisibilityService` — post a thread's plan for non-blocking visibility.
 *
 * The classifier's ambiguous-case LLM is bound behind `CLASSIFIER_LLM` (a declarative chain on a cheap
 * hardcoded Haiku, keyed off `ANTHROPIC_API_KEY`; key-less → returns undefined → gate defaults to
 * ask). `CHAT_SURFACE` is provided @Global by `SurfaceModule` (which the composing root imports), so it
 * resolves without importing it here.
 *
 * NOT YET WIRED into the app — the orchestrator (W9) imports this module into the Atlas composition
 * root. Zero v1 imports.
 */
@Module({
  providers: [
    {
      provide: CLASSIFIER_LLM,
      inject: [CredentialResolver],
      useFactory: (creds: CredentialResolver) =>
        new AnthropicClassifierLlm((orgId) => creds.anthropicKey(orgId)),
    },
    DecisionClassifier,
    PlanVisibilityService,
  ],
  exports: [DecisionClassifier, PlanVisibilityService, CLASSIFIER_LLM],
})
export class DecisionGateModule {}
