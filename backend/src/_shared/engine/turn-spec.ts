import type { ReasoningEffort, SessionEngine } from '@workspace/agent-engine';

export interface TurnSpec {
  engine: SessionEngine;

  prompt: string;
  systemPrompt: string;
  cwd: string;

  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  sessionId?: string;

  env?: Record<string, string | null>;
  credentialsFile?: string;
}
