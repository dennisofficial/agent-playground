import type { ReasoningEffort, SessionEngine } from '@workspace/agent-engine';

/** A mid-turn steering message the host pushes to a running engine (`turn:<id>:input`). */
export interface SteeringFrame {
  text: string;
  /** SDK injection priority, mirroring `SDKUserMessage.priority`: `now` interrupts the running turn with
   *  this text, `next` holds it for the turn after this one, `later` parks it. A mid-turn steer must use
   *  `now` — the dispatcher tears the input queue down at `result`, so a deferred message is never read. */
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
