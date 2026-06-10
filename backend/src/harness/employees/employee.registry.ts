import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { collectDecorated } from '../discovery.util';
import { escapeRegExp } from '../domain/text';
import type {
  EffortLevel,
  WorkerEngineName,
  WorkerMode,
} from '../engines/worker-engine.port';
import { AI_EMPLOYEE_METADATA } from './ai-employee.decorator';
import type { EmployeeDefinition } from './employee.types';

const ENGINE_NAMES: ReadonlyArray<WorkerEngineName> = [
  'claude',
  'codex',
  'langgraph',
];

/** The model + reasoning effort a worker run resolves to, by employee and phase. */
export interface ResolvedWorkerModel {
  /** Model id, or undefined to let the engine use its env/SDK default (e.g. Codex via CODEX_MODEL). */
  model?: string;
  /** Reasoning effort (Claude only). */
  effort?: EffortLevel;
}

// Per-engine model tiers: a high-reasoning model for PLAN, a cheaper one for EXECUTE. Single source
// of truth — an employee only sets planModel/execModel to deviate. Codex/LangGraph carry no fixed
// ids here (Codex resolves via CODEX_MODEL; effort is Claude-only).
const ENGINE_MODEL_TIERS: Record<
  WorkerEngineName,
  { plan: ResolvedWorkerModel; exec: ResolvedWorkerModel }
> = {
  claude: {
    plan: { model: 'claude-opus-4-8', effort: 'max' },
    exec: { model: 'claude-sonnet-4-6', effort: 'high' },
  },
  codex: { plan: {}, exec: {} },
  langgraph: { plan: {}, exec: {} },
};

/**
 * The roster, assembled by discovery: every `@AIEmployee()` class provider, validated and sorted at
 * boot. One process hosts every teammate; each is its own identity — own persona, chat graph,
 * checkpoint thread, memory owner, and job owner.
 * (Lookup/match helpers ported from playground/src/employees/index.ts.)
 */
@Injectable()
export class EmployeeRegistry implements OnModuleInit {
  private roster: EmployeeDefinition[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    const found = collectDecorated<EmployeeDefinition>(
      this.discovery,
      AI_EMPLOYEE_METADATA,
    );
    const roster = found
      .map((f) => f.instance)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // Fail boot loudly on a misconfigured roster — silent drift here corrupts scoping + addressing.
    // An EMPTY roster is also a misconfiguration (a forgotten module import would otherwise boot
    // clean and only crash lazily, minutes later, on the first relay's fallbackOwner()).
    if (roster.length === 0) {
      throw new Error(
        'No @AIEmployee providers found — register the roster classes in EmployeesModule',
      );
    }
    const ids = new Set<string>();
    for (const e of roster) {
      if (!e.id || e.id !== e.id.toLowerCase())
        throw new Error(`Employee id '${e.id}' must be non-empty lowercase`);
      if (ids.has(e.id)) throw new Error(`Duplicate employee id '${e.id}'`);
      ids.add(e.id);
      if (!ENGINE_NAMES.includes(e.engine)) {
        throw new Error(
          `Employee '${e.id}' declares unknown engine '${e.engine as string}'`,
        );
      }
    }
    const scrumMasters = roster.filter((e) => e.scrumMaster);
    if (scrumMasters.length !== 1) {
      throw new Error(
        `Exactly one employee must carry scrumMaster (found ${scrumMasters.length})`,
      );
    }
    this.roster = roster;
  }

  list(): ReadonlyArray<EmployeeDefinition> {
    return this.roster;
  }

  byId(id: string): EmployeeDefinition | undefined {
    return this.roster.find((b) => b.id === id);
  }

  /** The lowest-ordered employee — the owner used when a bot lookup misses. */
  fallbackOwner(): EmployeeDefinition {
    if (!this.roster.length)
      throw new Error('Empty roster — no fallback owner');
    return this.roster[0];
  }

  /** Roster employees @mentioned in a message (matches name or id, case-insensitive). */
  mentionedBots(text: string): EmployeeDefinition[] {
    const handles = new Set(
      (text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()),
    );
    return this.roster.filter(
      (b) => handles.has(b.name.toLowerCase()) || handles.has(b.id),
    );
  }

  /**
   * Roster employees ADDRESSED in a message — either @mentioned OR named outright ("Alex, can
   * you…"). In a chat, using a teammate's name is addressing them, so it counts as a direct hail.
   */
  addressedBots(text: string): EmployeeDefinition[] {
    const handles = new Set(
      (text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()),
    );
    // Names/ids are escaped before interpolation — a roster name like "C.J." or "Alex+" must match
    // literally, not as a pattern (and must never throw SyntaxError inside the scheduler).
    return this.roster.filter(
      (b) =>
        handles.has(b.name.toLowerCase()) ||
        handles.has(b.id) ||
        new RegExp(`\\b${escapeRegExp(b.name)}\\b`, 'i').test(text) ||
        new RegExp(`\\b${escapeRegExp(b.id)}\\b`, 'i').test(text),
    );
  }

  /**
   * True when a message broadcasts to the WHOLE team (`@here` / `@channel` / `@everyone`),
   * Slack-style. Requires the leading `@` so casual prose ("I'm here") doesn't trip it, and a
   * trailing word boundary so "@hereby" / "@channels" don't match.
   */
  isBroadcast(text: string): boolean {
    return /@(here|channel|everyone)\b/i.test(text);
  }

  /** One-line roster summary for prompts ("Alex — backend engineer; Sam — scrum master"). */
  rosterSummary(): string {
    return this.roster.map((b) => `${b.name} — ${b.role}`).join('; ');
  }

  /**
   * Resolve the model + effort for a worker run: the employee's per-phase override if set, else the
   * engine's default tier. PLAN → high-reasoning model + max effort; EXECUTE → the everyday model.
   */
  resolveWorkerModel(
    employee: EmployeeDefinition,
    mode: WorkerMode,
  ): ResolvedWorkerModel {
    const tier = ENGINE_MODEL_TIERS[employee.engine];
    if (mode === 'plan') {
      return {
        model: employee.planModel ?? tier.plan.model,
        effort: employee.planEffort ?? tier.plan.effort,
      };
    }
    return { model: employee.execModel ?? tier.exec.model };
  }
}
