import type { Type } from '@nestjs/common';
import type { EngineSpec } from '../engines/engine-spec';
import type { McpServerConfig, SkillSource } from '../skills/skill.types';
import type { IHarnessTool } from '../tools/tool.types';
import type { Capability } from './capability';
import type { EmployeeContext } from './employee-context';

/**
 * An employee — one self-contained AI teammate, as a single class decorated with `@AIEmployee()` and
 * extending `BaseEmployee`. Everything that makes a teammate distinct lives in that one file and is
 * the SINGLE source of truth for how it works: identity, the deep role knowledge seeding its prompts,
 * the engines its plan/execute work runs on (`planEngine`/`executeEngine`), and its capabilities
 * (`capabilities` — forced lifecycle hooks like self-review, and discretionary tools like deep
 * research; membership differs per employee). Adding a teammate = one new class in `roster/` + one
 * providers entry in `EmployeesModule`.
 *
 * BUILDERS, not constants: prompt/engine fields are FUNCTIONS of an injected `EmployeeContext`
 * (static today, a DB row tomorrow as employees are edited live from Slack). They MUST return
 * byte-stable output for a given employee — the chat prompt renders on every LLM step under a
 * `cache_control: ephemeral` breakpoint, so per-call variation silently busts the prompt cache.
 */
export interface EmployeeDefinition {
  /** Stable handle, lowercase (e.g. "alex"). Used for @mentions, scoping, and thread ids. */
  readonly id: string;
  /** Display name (e.g. "Alex"). */
  readonly name: string;
  /** Short role label (e.g. "backend engineer") — shown in the roster summary. */
  readonly role: string;
  /** Roster position — lower sorts first; the lowest-ordered employee is the fallback owner. */
  readonly sortOrder: number;
  /** Team-lead clearance (triage, dispatch, board ownership). Exactly one employee carries this. */
  readonly teamLead?: boolean;
  /**
   * Chat-tool allowlist as CLASS REFERENCES — the decorated tool class IS the token. Unset →
   * `DEFAULT_CHAT_TOOLSET`. Tool-triggered capabilities are folded in at graph-build time.
   */
  readonly tools?: ReadonlyArray<Type<IHarnessTool>>;
  /** Per-employee flavor appended to the shared identity line. Byte-stable (cache constraint). */
  readonly personality?: string;
  /** Agent Skill sources this employee is equipped with — materialized per-engine by the provisioner. */
  readonly skills?: ReadonlyArray<SkillSource>;
  /** MCP servers this employee may use — materialized per-engine by the provisioner. */
  readonly mcpServers?: ReadonlyArray<McpServerConfig>;
  /** Standing, discipline-specific work rules, rendered into BOTH chat and worker prompts. */
  readonly protocols?: ReadonlyArray<string>;
  /**
   * Lane terms that WAKE this employee from dormancy. After K consecutive soft-gate ignores in a
   * room a bot stops paying for the gate (see the conductor's dormancy mechanism); while dormant
   * only free programmatic checks can rouse it — its name/@handle/a broadcast, OR one of these
   * keywords. A keyword hit wakes the bot to RUN the soft gate (the keyword decides whether to
   * SPEND the gate; the gate still makes the real respond/ignore call). Matched case-insensitively
   * on word boundaries. Empty/unset → only name/@/broadcast can wake the bot. NOT part of any
   * cache-stable prompt — safe to vary.
   */
  readonly keywords?: ReadonlyArray<string>;

  /** The deep role knowledge folded into both surfaces' prompts (composes `ctx.team`). */
  roleContext(ctx: EmployeeContext): string;
  /** The full conversation-layer system prompt (cache-stable). */
  chatPrompt(ctx: EmployeeContext): string;
  /** The engine recipe for PLAN turns (engine + model + effort + worker system prompt). */
  planEngine(ctx: EmployeeContext): EngineSpec;
  /** The engine recipe for EXECUTE turns. */
  executeEngine(ctx: EmployeeContext): EngineSpec;
  /** The engine recipe for read-only INVESTIGATE turns (execute's engine; Claude swaps to a top-tier model). */
  investigateEngine(ctx: EmployeeContext): EngineSpec;
  /** This employee's capabilities — forced lifecycle hooks + discretionary tools (per-employee). */
  capabilities(ctx: EmployeeContext): Capability[];
}
