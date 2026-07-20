import type { EngineAuth, ReasoningEffort, SessionEngine } from '@workspace/agent-engine';

export interface TurnSpec {
  engine: SessionEngine;

  /** The user message for this turn (`query({ prompt })`). */
  prompt: string;
  systemPrompt: string;
  cwd: string;

  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  /** Resume handle for an existing engine session. */
  sessionId?: string;

  /** Auth material. The host-only `refreshBack` provenance is stripped before this crosses into the sandbox. */
  auth?: EngineAuth;
}
