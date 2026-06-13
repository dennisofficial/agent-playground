import type { EffortLevel, EWorkerEngineName } from './worker-engine.port';

/**
 * The RECIPE for one worker run — engine + model + reasoning effort + the composed system prompt.
 * An employee declares one of these per role (`planEngine`/`executeEngine`) and per lifecycle/tool
 * capability (`Capability.spec`); the runner feeds it into `RunWorkerArgs`. This is the unit that
 * replaces the old `ENGINE_MODEL_TIERS` + `EmployeeDefinition.roles` indirection: the employee is
 * now the complete source of truth for how each of its engines runs.
 *
 * `systemPrompt` is built by the employee's `BaseEmployee` builders, with the SPEC's engine (the
 * worker tool-guide is engine-specific), so a Codex review spec on a Claude-base employee still
 * renders Codex tool names. `model`/`effort` come from a shared preset (`engine-presets.ts`) so the
 * model tier stays single-sourced even though the spec lives on the employee.
 */
export interface EngineSpec {
  /** Which engine this run executes on (claude / codex / langgraph). */
  engine: EWorkerEngineName;
  /** Model id, or undefined to let the engine use its env/SDK default (e.g. Codex via CODEX_MODEL). */
  model?: string;
  /** Reasoning effort (Claude only). Unset → the model's default. */
  effort?: EffortLevel;
  /** The composed worker persona for this run — built with THIS spec's engine. */
  systemPrompt: string;
}
