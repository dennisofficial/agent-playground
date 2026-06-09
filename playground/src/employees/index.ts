/**
 * The employee registry. One process hosts every teammate; each is its own identity — own persona, chat
 * graph, checkpoint, memory owner, and job owner. Adding a teammate is one new file in this folder plus
 * one entry in `ROSTER` below; nothing else in the codebase needs to change.
 *
 * Mirrors the engine registry (`../engines/index.ts`): per-unit definitions imported here, exposed
 * through a small set of lookup/match helpers.
 */
import type { EffortLevel, WorkerEngineName } from '../engines/types.js';
import type { WorkerMode } from '../jobs.js';
import { alex } from './alex.js';
import { james } from './james.js';
import { sam } from './sam.js';
import type { Employee } from './types.js';

export type { Employee } from './types.js';

export const ROSTER: Employee[] = [alex, james, sam];

export const botById = (id: string): Employee | undefined => ROSTER.find((b) => b.id === id);

/** The model + reasoning effort a worker run resolves to, by employee and phase. */
export interface ResolvedWorkerModel {
  /** Model id, or undefined to let the engine use its env/SDK default (e.g. Codex via CODEX_MODEL). */
  model?: string;
  /** Reasoning effort (Claude only). */
  effort?: EffortLevel;
}

// Per-engine model tiers: a high-reasoning model for PLAN, a cheaper one for EXECUTE. Single source of
// truth — an employee only sets planModel/execModel to deviate. Codex/LangGraph carry no fixed ids here
// (Codex resolves via CODEX_MODEL; effort is Claude-only), so they fall back to the engine's own default
// until concrete ids are wired.
const ENGINE_MODEL_TIERS: Record<
  WorkerEngineName,
  { plan: ResolvedWorkerModel; exec: ResolvedWorkerModel }
> = {
  claude: {
    plan: { model: 'claude-opus-4-8', effort: 'max' },
    exec: { model: 'claude-sonnet-4-6' },
  },
  codex: { plan: {}, exec: {} },
  langgraph: { plan: {}, exec: {} },
};

/**
 * Resolve the model + effort for a worker run: the employee's per-phase override if set, else the
 * engine's default tier. PLAN → high-reasoning model + max effort; EXECUTE → the everyday model.
 */
export function resolveWorkerModel(employee: Employee, mode: WorkerMode): ResolvedWorkerModel {
  const tier = ENGINE_MODEL_TIERS[employee.engine];
  if (mode === 'plan') {
    return {
      model: employee.planModel ?? tier.plan.model,
      effort: employee.planEffort ?? tier.plan.effort,
    };
  }
  return { model: employee.execModel ?? tier.exec.model };
}

/** Roster employees @mentioned in a message (matches name or id, case-insensitive). */
export function mentionedBots(text: string): Employee[] {
  const handles = new Set((text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()));
  return ROSTER.filter((b) => handles.has(b.name.toLowerCase()) || handles.has(b.id));
}

/**
 * Roster employees ADDRESSED in a message — either @mentioned OR named outright ("Alex, can you…").
 * In a chat, using a teammate's name is addressing them, so it counts as a direct hail.
 */
export function addressedBots(text: string): Employee[] {
  const handles = new Set((text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()));
  return ROSTER.filter(
    (b) =>
      handles.has(b.name.toLowerCase()) ||
      handles.has(b.id) ||
      new RegExp(`\\b${b.name}\\b`, 'i').test(text) ||
      new RegExp(`\\b${b.id}\\b`, 'i').test(text),
  );
}

/** One-line roster summary for prompts ("Alex — backend engineer; James — marketing & analytics"). */
export const rosterSummary = (): string => ROSTER.map((b) => `${b.name} — ${b.role}`).join('; ');
