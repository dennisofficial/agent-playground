/**
 * W5 — the decision-class gate. Public barrel: the classifier (still used by the brain's fast-path
 * safety gate), visibility posting, the module, and the local domain types. Zero v1 imports.
 */
export {
  AnthropicClassifierLlm,
  CLASSIFIER_LLM,
  type ClassifierLlm,
  type ClassifierLlmVerdict,
} from './classifier-llm';
export * from './decision-classifier.service';
export * from './decision-gate.module';
export * from './decision-gate.types';
export * from './plan-visibility.service';
