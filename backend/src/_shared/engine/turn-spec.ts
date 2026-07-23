import type { ReasoningEffort, SessionEngine } from '@workspace/agent-engine';

/** A mid-turn steering message the host pushes to a running engine (`turn:<id>:input`). */
export interface SteeringFrame {
  text: string;
  /** SDK injection priority — 'next' = at the next tool boundary (our `now`-priority mid-turn steer). */
  priority?: 'now' | 'next' | 'later';
}

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
