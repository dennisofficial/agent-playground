import type { WorkerEvent } from '../engines/worker-engine.port';
import type { TenantKeys } from '../llm-keys/tenant-credential.service';
import type { EmployeeDefinition } from '../employees/employee.types';
import type { Session } from '../sessions/session-registry.port';

/**
 * The harness lifecycle stages a capability can hook. Engine-agnostic and in-process — modeled on
 * Claude Code's `settings.json` hooks (event key · matcher · blocking/async · order · timeout) but
 * with this repo's own typed contract (it must work for Claude/Codex/LangGraph, so CC's vendor hooks
 * can't be reused).
 *
 * Only `PlanFinished` carries behavior today; the others are declared-but-unwired seams kept so the
 * stage map and runner are real (the DB-driven future grows here without reshaping the runtime).
 */
export enum LifecycleEvent {
  /** A background planning turn produced a plan. Blocking hooks may transform the plan before it
   * relays back to the owning employee (the self-review pass lives here). */
  PlanFinished = 'plan.finished',
}

/** The payload for `plan.finished`. The runner passes it through the blocking middleware chain; each
 * hook may return a partial that REPLACES only the contract-allowed fields (see TRANSFORM_CONTRACT). */
export interface PlanFinishedPayload {
  readonly employee: EmployeeDefinition;
  readonly session: Session;
  /** The plan text as it stands — a blocking hook may replace this. */
  planBody: string;
  /** The planning engine's resume handle — a blocking hook (which revises on that session) may
   * replace this so the revised plan's session id travels forward. */
  engineSessionId?: string;
  readonly worktreePath: string;
  readonly keys: TenantKeys;
  readonly signal: AbortSignal;
  /** Stream a hook's engine progress to the session transcript (provided by the session runner). */
  readonly onProgress?: (e: WorkerEvent) => void;
}

/** Maps each `LifecycleEvent` to its payload shape — the typed stage map. */
export interface LifecyclePayloads {
  [LifecycleEvent.PlanFinished]: PlanFinishedPayload;
}

/**
 * The per-event TRANSFORM CONTRACT: exactly which payload fields a blocking hook may return-and-
 * replace. The runner takes ONLY these keys from a hook's returned partial and ignores the rest, so
 * a hook can't quietly mutate read-only context (employee, session, worktreePath, keys, signal).
 */
export const TRANSFORM_CONTRACT: {
  [E in LifecycleEvent]: ReadonlyArray<keyof LifecyclePayloads[E]>;
} = {
  [LifecycleEvent.PlanFinished]: ['planBody', 'engineSessionId'],
};

/** What a blocking hook returns: a partial of the replaceable fields, or nothing (no transform). */
export type LifecycleResult<E extends LifecycleEvent> = Partial<
  LifecyclePayloads[E]
> | void;
