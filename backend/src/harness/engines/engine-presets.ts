import type { EngineSpec } from './engine-spec';
import { EWorkerEngineName } from './worker-engine.port';

/**
 * Shared engine/model/effort presets — the model-tier knowledge that lived in `ENGINE_MODEL_TIERS`,
 * kept central as the SINGLE source of truth. An employee composes a role spec by spreading a preset
 * and adding its built `systemPrompt`:
 *
 *   planEngine(ctx) { return { ...PLAN_CLAUDE, systemPrompt: this.workerPrompt(ctx, { engine: PLAN_CLAUDE.engine }) }; }
 *
 * A model bump stays a one-file edit here; per-employee deviation is still possible by overriding a
 * field on the spread (`{ ...PLAN_CLAUDE, model: '…' }`). Codex/LangGraph carry no fixed model id
 * (Codex resolves via CODEX_MODEL; effort is Claude-only).
 */
export type EnginePreset = Omit<EngineSpec, 'systemPrompt'>;

// Claude: a high-reasoning model for PLAN/REVIEW, the everyday model for EXECUTE.
export const PLAN_CLAUDE: EnginePreset = {
  engine: EWorkerEngineName.CLAUDE,
  model: 'claude-opus-4-8',
  effort: 'max',
};
export const EXECUTE_CLAUDE: EnginePreset = {
  engine: EWorkerEngineName.CLAUDE,
  model: 'claude-sonnet-4-6',
  effort: 'high',
};
export const REVIEW_CLAUDE: EnginePreset = {
  engine: EWorkerEngineName.CLAUDE,
  model: 'claude-opus-4-8',
  effort: 'high',
};

// Codex resolves its own model/effort from its env/SDK; the preset just pins the engine.
export const PLAN_CODEX: EnginePreset = { engine: EWorkerEngineName.CODEX };
export const EXECUTE_CODEX: EnginePreset = { engine: EWorkerEngineName.CODEX };
export const REVIEW_CODEX: EnginePreset = { engine: EWorkerEngineName.CODEX };

// LangGraph (in-process LangChain worker) — no model id pinned here.
export const PLAN_LANGGRAPH: EnginePreset = {
  engine: EWorkerEngineName.LANGGRAPH,
};
export const EXECUTE_LANGGRAPH: EnginePreset = {
  engine: EWorkerEngineName.LANGGRAPH,
};
