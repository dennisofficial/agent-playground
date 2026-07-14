import type {
  EngineAuth,
  EngineEvent,
  EngineHomeKey,
  EngineMode,
  EngineRunResult,
  ReasoningEffort,
  SessionEngine,
} from './types.js';

export type EngineCapability =
  | 'postToolUseContext' | 'writeGuard' | 'midTurnSteer' | 'holdTimer' | 'subagents' | 'richStream';

export interface SteerChannel { push(message: string): void; }
export interface EngineLocalHooks {           // capability-gated JIT primitives (built by EngineCore in thread 3)
  postToolUseContext?: (toolName: string, input: unknown, tokens: number) => string | null;
  writeGuard?: (toolName: string, input: unknown) => { allow: boolean; reason?: string };
  steer?: SteerChannel;
  holdCapMs?: number;
  /** Engine-local mid-turn token-threshold steer (the `leg-rotation` JIT rule's Codex wiring — Claude's OWN
   *  rotation path is driven by a separate, pre-existing `RunEngineArgs.rotationNudge` mechanism gated to
   *  builder threads and is UNCHANGED by this hook). */
  rotation?: { softTokens: number; reminderDeltaTokens: number; softText: string; reminderText: string };
}
export interface AdapterRunArgs {             // slim, vendor-agnostic; EngineCore maps RunEngineArgs → this
  engine: SessionEngine; task: string; cwd: string; systemPrompt: string;
  mode: EngineMode; sandboxKey: EngineHomeKey; sessionId?: string; auth?: EngineAuth;
  model?: string; modelReasoningEffort?: ReasoningEffort; writableRoots?: string[];
  richStream?: boolean; persistAuthRefresh?: boolean; signal?: AbortSignal;
  onEvent?: (e: EngineEvent) => void; hooks?: EngineLocalHooks;
  extra?: { claudeOptions?: unknown; codexBridgeTools?: string[]; codexExtraMcpServers?: unknown };
}
export interface EngineAdapter {
  readonly engine: SessionEngine;
  readonly capabilities: ReadonlySet<EngineCapability>;
  run(args: AdapterRunArgs): Promise<EngineRunResult>;
}
