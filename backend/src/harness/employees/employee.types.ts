import type { Type } from '@nestjs/common';
import type {
  EffortLevel,
  WorkerEngineName,
} from '../engines/worker-engine.port';
import type { McpServerConfig, SkillSource } from '../skills/skill.types';
import type { IHarnessTool } from '../tools/tool.types';

/**
 * An employee — one self-contained AI teammate, as a single class decorated with `@AIEmployee()`.
 * Everything that makes a teammate distinct lives in that one file: identity, the deep role
 * knowledge seeding its system prompt, the engine its background work runs on, its skills, and the
 * tools it may use. Adding a teammate = one new class in `roster/` + one providers entry in
 * `EmployeesModule` — nothing else in the harness changes.
 */
export interface EmployeeDefinition {
  /** Stable handle, lowercase (e.g. "alex"). Used for @mentions, scoping, and thread ids. */
  readonly id: string;
  /** Display name (e.g. "Alex"). */
  readonly name: string;
  /** Short role label (e.g. "backend engineer") — shown in the roster summary. */
  readonly role: string;
  /**
   * Roster position. Discovery order is non-deterministic, so ordering is explicit: lower sorts
   * first. Groups the build team (backend → frontend → design) ahead of marketing + the lead, and the
   * lowest-ordered employee is the fallback owner when a bot lookup misses.
   */
  readonly sortOrder: number;
  /**
   * Team-lead clearance: triage, dispatch/staffing, team task board ownership, and cross-owner
   * authority (sees every teammate's reminders; can assign + clear work across the team). Exactly
   * one employee carries this. Read programmatically — never inferred from the `role` string.
   */
  readonly teamLead?: boolean;
  /**
   * The deep role knowledge folded into this employee's chat system prompt. MUST be a static,
   * byte-stable string: the chat prompt runs on every LLM step under a `cache_control: ephemeral`
   * breakpoint, so any per-call variation here silently busts the prompt cache. No file reads, no
   * volatile interpolation, no getters that compute.
   */
  readonly roleContext: string;
  /**
   * The engine this employee's dispatched background work runs on. An employee is LOCKED to its
   * engine — no per-dispatch override; switch engines by changing this field.
   */
  readonly engine: WorkerEngineName;
  /**
   * Per-phase model tiering (optional overrides; per-engine defaults in
   * `EmployeeRegistry.resolveWorkerModel` apply when unset). PLAN runs on a high-reasoning model,
   * EXECUTE on a cheaper one.
   */
  readonly planModel?: string;
  readonly planEffort?: EffortLevel;
  readonly execModel?: string;
  /**
   * Chat-tool allowlist as CLASS REFERENCES — the decorated tool class IS the token
   * (e.g. `tools: [DispatchJobTool, RecallTool]`). Unset → `DEFAULT_CHAT_TOOLSET`. Resolved by
   * `ToolRegistry.toStructuredTools` at graph-build time; an unregistered class fails loudly.
   */
  readonly tools?: ReadonlyArray<Type<IHarnessTool>>;
  /**
   * Per-employee flavor appended to the shared identity line. Same byte-stability constraint as
   * `roleContext` (flows into the cached chat prompt).
   */
  readonly personality?: string;
  /** Agent Skill sources this employee is equipped with (scaffold — loader is a no-op this pass). */
  readonly skills?: ReadonlyArray<SkillSource>;
  /** MCP servers this employee may use (scaffold — not wired into engines yet). */
  readonly mcpServers?: ReadonlyArray<McpServerConfig>;
  /**
   * Standing, discipline-specific work rules, rendered into BOTH chat and worker prompts. Keep
   * discipline-specific (shared team rules live in the persona builder). Static literals — same
   * caching constraint as `roleContext`.
   */
  readonly protocols?: ReadonlyArray<string>;
}
