import { Module } from '@nestjs/common';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { AnthropicClassifierLlm, CLASSIFIER_LLM } from './classifier-llm';
import { DecisionClassifier } from './decision-classifier.service';
import { PlanVisibilityService } from './plan-visibility.service';

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
