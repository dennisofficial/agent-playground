import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { collectDecorated } from '../discovery.util';
import { escapeRegExp } from '../domain/text';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { EffortLevel, WorkerRole } from '../engines/worker-engine.port';
import { AI_EMPLOYEE_METADATA } from './ai-employee.decorator';
import type { EmployeeDefinition } from './employee.types';

/** The engine + model + reasoning effort a worker run resolves to, by employee and role. */
export interface ResolvedWorkerModel {
  /** The engine this role runs on (the employee's base `engine`, or a `roles.<role>.engine` override). */
  engine: EWorkerEngineName;
  /** Model id, or undefined to let the engine use its env/SDK default (e.g. Codex via CODEX_MODEL). */
  model?: string;
  /** Reasoning effort (Claude only). */
  effort?: EffortLevel;
}

interface RoleTier {
  model?: string;
  effort?: EffortLevel;
}

// Per-engine, per-role model tiers: a high-reasoning model for PLAN/REVIEW, a cheaper one for
// EXECUTE. Single source of truth — an employee only sets a `roles` binding to deviate. Codex/
// LangGraph carry no fixed ids here (Codex resolves via CODEX_MODEL; effort is Claude-only).
const ENGINE_MODEL_TIERS: Record<
  EWorkerEngineName,
  Record<WorkerRole, RoleTier>
> = {
  [EWorkerEngineName.CLAUDE]: {
    plan: { model: 'claude-opus-4-8', effort: 'max' },
    execute: { model: 'claude-sonnet-4-6', effort: 'high' },
    review: { model: 'claude-opus-4-8', effort: 'high' },
  },
  [EWorkerEngineName.CODEX]: { plan: {}, execute: {}, review: {} },
  [EWorkerEngineName.LANGGRAPH]: { plan: {}, execute: {}, review: {} },
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
    }
    const leads = roster.filter((e) => e.teamLead);
    if (leads.length !== 1) {
      throw new Error(
        `Exactly one employee must carry teamLead (found ${leads.length})`,
      );
    }
    this.roster = roster;
  }

  /** The one team lead (validated exactly-one at boot). */
  teamLead(): EmployeeDefinition {
    const lead = this.roster.find((e) => e.teamLead);
    if (!lead) throw new Error('Empty roster — no team lead');
    return lead;
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

  /** One-line roster summary for prompts ("Alex — backend engineer; Sam — team lead"). */
  rosterSummary(): string {
    return this.roster.map((b) => `${b.name} — ${b.role}`).join('; ');
  }

  /**
   * Resolve the engine + model + effort for a worker run by ROLE. Precedence: the employee's
   * `roles.<role>` binding → the deprecated flat fields (`planModel`/`planEffort`/`execModel`) →
   * the resolved engine's default role tier. The engine is the role's `engine` override or the
   * employee's base `engine`; the model tier is keyed off THAT engine. PLAN/REVIEW → high-reasoning;
   * EXECUTE → the everyday model.
   */
  resolveWorkerModel(
    employee: EmployeeDefinition,
    role: WorkerRole,
  ): ResolvedWorkerModel {
    const binding = employee.roles?.[role];
    const engine = binding?.engine ?? employee.engine;
    const tier = ENGINE_MODEL_TIERS[engine][role];
    // Deprecated flat fields only alias plan/execute (there was never a flat review field).
    const legacyModel =
      role === 'plan'
        ? employee.planModel
        : role === 'execute'
          ? employee.execModel
          : undefined;
    const legacyEffort = role === 'plan' ? employee.planEffort : undefined;
    return {
      engine,
      model: binding?.model ?? legacyModel ?? tier.model,
      effort: binding?.effort ?? legacyEffort ?? tier.effort,
    };
  }
}
