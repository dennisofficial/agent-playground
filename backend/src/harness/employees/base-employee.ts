import type { Type } from '@nestjs/common';
import type { EngineSpec } from '../engines/engine-spec';
import {
  EXECUTE_CLAUDE,
  INVESTIGATE_CLAUDE_MODEL,
  PLAN_CLAUDE,
  type EnginePreset,
} from '../engines/engine-presets';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { McpServerConfig, SkillSource } from '../skills/skill.types';
import type { IHarnessTool } from '../tools/tool.types';
import type { Capability } from './capability';
import type { EmployeeContext } from './employee-context';
import type { EmployeeDefinition } from './employee.types';
import {
  BACKGROUND_WORK_RULES,
  CANDOR_RULES,
  CHAT_PROMPT,
  STATUS_COLUMN_GUIDE,
  TEAM_ETHOS,
  TEAM_RULES,
  WORKER_DIRECTIVE,
  WORKER_PROMPT,
  WORKER_TOOL_GUIDE,
} from './persona.prompts';

/**
 * The base every roster teammate extends — the self-describing employee. It owns prompt ASSEMBLY
 * (chat + worker) and the default engine wiring; a concrete employee declares only what's distinct:
 * identity, `roleContext`, its plan/execute presets (override `planPreset`/`executePreset` to run on
 * a different engine), and its `capabilities`.
 *
 * CACHE CONSTRAINT: `chatPrompt` renders on every LLM step under a `cache_control: ephemeral`
 * breakpoint — everything the builders fold in must be deterministic for a given employee (static
 * strings, stable joins, byte-stable `ctx`), or it silently busts the prompt cache.
 */
export abstract class BaseEmployee implements EmployeeDefinition {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly role: string;
  abstract readonly sortOrder: number;
  readonly teamLead?: boolean;
  readonly tools?: ReadonlyArray<Type<IHarnessTool>>;
  readonly personality?: string;
  readonly skills?: ReadonlyArray<SkillSource>;
  readonly mcpServers?: ReadonlyArray<McpServerConfig>;
  readonly protocols?: ReadonlyArray<string>;

  /** The engine preset PLAN turns run on. Override to plan on a different engine/model. */
  protected readonly planPreset: EnginePreset = PLAN_CLAUDE;
  /** The engine preset EXECUTE turns run on. */
  protected readonly executePreset: EnginePreset = EXECUTE_CLAUDE;

  /** The deep role knowledge — concrete employees compose it from `ctx.team` + role-specific prose. */
  abstract roleContext(ctx: EmployeeContext): string;

  /** Default: no capabilities. Engineers add self-review; Nora adds deep research. */
  capabilities(_ctx: EmployeeContext): Capability[] {
    return [];
  }

  planEngine(ctx: EmployeeContext): EngineSpec {
    return this.engineSpec(ctx, this.planPreset);
  }

  executeEngine(ctx: EmployeeContext): EngineSpec {
    return this.engineSpec(ctx, this.executePreset);
  }

  investigateEngine(ctx: EmployeeContext): EngineSpec {
    const spec = this.executeEngine(ctx);
    // INVARIANT: investigate is execute's engine with a model-only override — the ENGINE never
    // changes. EngineHomeProvisioner's [plan, execute] home set + replySession's engine guard rely on
    // this. Claude investigations run a top-tier reasoning model (they exist to BACK facts/decisions
    // with the real code, not answer from memory); Codex/LangGraph route their own models.
    return spec.engine === EWorkerEngineName.CLAUDE
      ? { ...spec, model: INVESTIGATE_CLAUDE_MODEL }
      : spec;
  }

  /**
   * Build a full `EngineSpec` from a preset by composing the worker prompt for the preset's engine.
   * Employees use this in `capabilities()` too (e.g. a cross-engine self-review spec), so the worker
   * prompt always renders the correct engine's tool names.
   */
  protected engineSpec(ctx: EmployeeContext, preset: EnginePreset): EngineSpec {
    return {
      ...preset,
      systemPrompt: this.workerPrompt(ctx, { engine: preset.engine }),
    };
  }

  // ── prompt builders (ported from PersonaService) ──────────────────────────

  private identityLine(): string {
    const base = `
You are ${this.name}, the ${this.role} — a capable, conscientious AI employee. You have real
taste and judgment: you're precise, and you say plainly when something is blocked or uncertain
instead of guessing.
`.trim();
    return this.personality ? `${base} ${this.personality}` : base;
  }

  // Both render into both surfaces, are static (deterministic join/map under `?.length` guards), and
  // return a leading-blank-line block (or '' when unset). `skillsBlock` is a PLACEHOLDER until the
  // SkillLoader is real — it renders the declared sources' names only when present.
  private skillsBlock(): string {
    return this.skills?.length
      ? `\n\nYour core skills: ${this.skills.map((s) => (s.kind === 'git' ? s.url : s.path)).join(', ')}.`
      : '';
  }

  private protocolsBlock(): string {
    return this.protocols?.length
      ? `\n\nStanding protocols you always follow:\n${this.protocols.map((p) => `- ${p}`).join('\n')}`
      : '';
  }

  chatPrompt(ctx: EmployeeContext): string {
    return CHAT_PROMPT({
      identity: this.identityLine(),
      roleContext: this.roleContext(ctx),
      skills: this.skillsBlock(),
      protocols: this.protocolsBlock(),
      roster: ctx.roster,
      name: this.name,
      candor: CANDOR_RULES,
      backgroundWork: BACKGROUND_WORK_RULES,
      teamRules: TEAM_RULES,
      statusColumnGuide: STATUS_COLUMN_GUIDE,
    });
  }

  /**
   * The system prompt for a background session — the SAME identity as the chat surface plus
   * engine-correct tool names for THIS spec's engine (a role/capability may run on a different engine
   * than the employee's others). Mode-agnostic and byte-identical across a session's turns.
   */
  protected workerPrompt(
    ctx: EmployeeContext,
    { engine }: { engine: EWorkerEngineName },
  ): string {
    // NOTE: worker-surface only — the chat prompt explicitly tells the bot NOT to prefix replies
    // with its name (chat convention: your replies show as you). The "start with your name"
    // instruction in WORKER_PROMPT is the deliberate inverse for background sessions; session-runner's
    // coherence check validates it. Two separate surfaces, no conflict.
    return WORKER_PROMPT({
      identity: this.identityLine(),
      directive: WORKER_DIRECTIVE,
      name: this.name,
      toolGuide: WORKER_TOOL_GUIDE[engine],
      skills: this.skillsBlock(),
      protocols: this.protocolsBlock(),
      roster: ctx.roster,
      candor: CANDOR_RULES,
      ethos: TEAM_ETHOS,
    });
  }
}
