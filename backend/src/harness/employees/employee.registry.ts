import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { collectDecorated } from '../discovery.util';
import { escapeRegExp } from '../domain/text';
import { AI_EMPLOYEE_METADATA } from './ai-employee.decorator';
import { PHASE_CONFIG_METADATA } from './phase-config.decorator';
import type { EmployeeContext } from './employee-context';
import type { EmployeeDefinition } from './employee.types';
import { TEAM_CONTEXT } from './roster/shared';
import { LifecycleEvent } from '../lifecycle/lifecycle.types';

/** The lifecycle events a capability may legally hook (boot-validated). */
const KNOWN_LIFECYCLE_EVENTS = new Set<string>(Object.values(LifecycleEvent));

/**
 * The roster, assembled by discovery: every `@AIEmployee()` class provider, validated and sorted at
 * boot. One process hosts every teammate; each is its own identity — own persona, chat graph,
 * checkpoint thread, memory owner, and job owner.
 * (Lookup/match helpers ported from playground/src/employees/index.ts.)
 */
@Injectable()
export class EmployeeRegistry implements OnModuleInit {
  private roster: EmployeeDefinition[] = [];
  /**
   * Synthetic worker identities (pipeline phase-configs), kept SEPARATE from the chat roster: they are
   * resolvable (`byId`) and provisioned a home (`provisionable()`), but NEVER enter `list()`, the
   * roster summary, or addressing — the conductor would otherwise schedule/classify them as phantom
   * channel participants.
   */
  private phaseConfigs: EmployeeDefinition[] = [];

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

    // Phase-configs: discovered SEPARATELY (own metadata key), kept off the chat roster. Validate ids
    // are non-empty lowercase and unique across the roster + each other (they share the `byId` /
    // home-provisioning id space). The lead/non-empty roster rules deliberately DON'T apply here.
    const phaseConfigs = collectDecorated<EmployeeDefinition>(
      this.discovery,
      PHASE_CONFIG_METADATA,
    ).map((f) => f.instance);
    for (const p of phaseConfigs) {
      if (!p.id || p.id !== p.id.toLowerCase())
        throw new Error(`Phase-config id '${p.id}' must be non-empty lowercase`);
      if (ids.has(p.id))
        throw new Error(
          `Phase-config id '${p.id}' collides with an existing employee/phase-config id`,
        );
      ids.add(p.id);
    }
    this.phaseConfigs = phaseConfigs;

    // Validate every declared capability (roster + phase-configs) once context exists: a lifecycle
    // hook must name a known event; capability names must be unique per identity and not empty.
    // Resolving each spec also surfaces a broken builder at boot rather than mid-turn.
    const ctx = this.context();
    for (const e of [...roster, ...phaseConfigs]) {
      const caps = e.capabilities(ctx);
      const names = new Set<string>();
      for (const cap of caps) {
        if (!cap.name)
          throw new Error(`Employee '${e.id}' has a capability with no name`);
        if (names.has(cap.name))
          throw new Error(
            `Employee '${e.id}' has duplicate capability '${cap.name}'`,
          );
        names.add(cap.name);
        cap.spec(ctx); // throws here (at boot) if the spec builder is broken
        if (
          cap.trigger.kind === 'lifecycle' &&
          !KNOWN_LIFECYCLE_EVENTS.has(cap.trigger.on)
        )
          throw new Error(
            `Employee '${e.id}' capability '${cap.name}' hooks unknown lifecycle event '${cap.trigger.on}'`,
          );
      }
    }
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
    return (
      this.roster.find((b) => b.id === id) ??
      this.phaseConfigs.find((b) => b.id === id)
    );
  }

  /**
   * Roster ∪ phase-configs — every identity that needs a per-engine skill/MCP home provisioned. Used
   * ONLY by `EngineHomeProvisioner`, never as the chat roster (that's `list()`).
   */
  provisionable(): ReadonlyArray<EmployeeDefinition> {
    return [...this.roster, ...this.phaseConfigs];
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

  /**
   * One-line CHAT-roster summary ("Atlas — orchestrator"). Chat-roster only — phase-configs never leak
   * in (asserted by discovery.spec). Distinct from the prompt `${roster}`, which is the pipeline roles
   * (see `phaseRoleSummary`): with a single orchestrator this would be a useless prompt input.
   */
  rosterSummary(): string {
    return this.roster.map((b) => `${b.name} — ${b.role}`).join('; ');
  }

  /**
   * One-line summary of the pipeline phase ROLES ("Backend — backend engineer; Frontend — …"). This is
   * what prompts render as `${roster}` — "the specialist roles you dispatch / in the pipeline" — since
   * the specialists are the phase-configs, not chat participants.
   */
  private phaseRoleSummary(): string {
    return this.phaseConfigs.map((p) => `${p.name} — ${p.role}`).join('; ');
  }

  /**
   * The agnostic context the harness injects into an employee's builders (`roleContext`/`planEngine`/
   * `capabilities`). Static today (team frame + the pipeline phase roles), a DB row tomorrow. Single
   * source so the lifecycle runner, session tools, and PersonaService all build identical bytes.
   */
  context(): EmployeeContext {
    return { team: TEAM_CONTEXT, roster: this.phaseRoleSummary() };
  }
}
