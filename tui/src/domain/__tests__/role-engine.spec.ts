import { describe, expect, it } from 'bun:test';
import { EEngine, EThreadRole } from '../../generated/prisma/enums.js';
import {
  EClaudeEffort,
  ECodexEffort,
  ROLE_BINDINGS,
  bindingFor,
  engineFor,
  parseEngineConfig,
  roleLabel,
} from '../role-engine.js';

const ROLES = Object.values(EThreadRole);

describe('ROLE_BINDINGS', () => {
  /**
   * The table is `Record<EThreadRole, …>`, so a MISSING role is a type error. This catches the other
   * half — a role added to the schema and given a binding copied from its neighbour, which
   * typechecks and silently runs the new role on the wrong engine.
   */
  it('binds every role in the schema', () => {
    for (const role of ROLES) {
      expect(bindingFor(role)).toBeDefined();
    }
  });

  it('never disagrees with its own key', () => {
    for (const role of ROLES) {
      expect(bindingFor(role).role).toBe(role);
    }
  });

  it('gives every role a model, an effort and a blurb — all are shown, none may be blank', () => {
    for (const role of ROLES) {
      const binding = bindingFor(role);
      expect(binding.engine.model.length).toBeGreaterThan(0);
      expect(binding.engine.effort.length).toBeGreaterThan(0);
      expect(binding.blurb.length).toBeGreaterThan(0);
    }
  });

  it('ends the binding at three fields — mode, execution, inputPolicy and runner are dead', () => {
    for (const role of ROLES) {
      expect(Object.keys(bindingFor(role)).sort()).toEqual(['blurb', 'engine', 'role']);
    }
  });

  it('sends the review roles to a DIFFERENT engine than the work they review', () => {
    // The point of a second engine is that it did not write the thing it is checking.
    for (const role of ROLES.filter((r) => r.includes('review'))) {
      expect(engineFor(role)).toBe(EEngine.codex);
    }
    expect(engineFor(EThreadRole.builder)).toBe(EEngine.claude);
  });

  /**
   * The effort axis earns its place through the review roles and nothing else: `xhigh` is "look
   * harder than the author did". Everything else takes `high`, which is Claude's own default — and
   * `high` reads identically in both vocabularies, which is exactly why the field is NOT shared.
   */
  it('gives both review roles xhigh and everyone else high', () => {
    for (const role of ROLES) {
      const expected = role.includes('review') ? 'xhigh' : 'high';
      // Stringified because the two efforts are different enums that happen to spell `high` the
      // same way — which is the whole reason they are not one shared enum.
      expect(String(bindingFor(role).engine.effort)).toBe(expected);
    }
  });

  /**
   * Legacy ran builders on sonnet/high. Not restored: a cheaper builder rotates about twice as
   * often, and a handoff is the lossiest event in the system.
   */
  it('uses one model per engine, so a bump cannot be applied to half the roles', () => {
    const byEngine = new Map<EEngine, Set<string>>();
    for (const binding of Object.values(ROLE_BINDINGS)) {
      const models = byEngine.get(binding.engine.kind) ?? new Set<string>();
      models.add(binding.engine.model);
      byEngine.set(binding.engine.kind, models);
    }
    for (const models of byEngine.values()) {
      expect(models.size).toBe(1);
    }
    expect(bindingFor(EThreadRole.builder).engine.model).toBe('claude-opus-5');
  });

  it('hands out configs that cannot be mutated through each other', () => {
    // The arms are spread from one shared literal per engine; sharing the OBJECT would let a caller
    // that edits a binding rewrite every other role bound to the same engine.
    expect(bindingFor(EThreadRole.intake).engine).not.toBe(bindingFor(EThreadRole.task).engine);
  });
});

describe('parseEngineConfig', () => {
  it('round-trips a config that went through JSON, which is how the column stores it', () => {
    const binding = bindingFor(EThreadRole.master_review);
    const stored: unknown = JSON.parse(JSON.stringify(binding.engine));
    expect(parseEngineConfig(stored)).toEqual(binding.engine);
  });

  /** A row written before the column existed carries `null`; the flat engine/model still answer. */
  it('returns null for a missing config rather than guessing one', () => {
    expect(parseEngineConfig(null)).toBeNull();
    expect(parseEngineConfig(undefined)).toBeNull();
  });

  it('refuses an effort from the WRONG engine vocabulary', () => {
    // `none` is real for Codex and meaningless for Claude — accepting it would let a config claim
    // an effort the Claude SDK rejects at the wire.
    expect(
      parseEngineConfig({ kind: EEngine.claude, model: 'claude-opus-5', effort: ECodexEffort.none }),
    ).toBeNull();
    expect(
      parseEngineConfig({ kind: EEngine.claude, model: 'claude-opus-5', effort: 'max' }),
    ).toEqual({
      kind: EEngine.claude,
      model: 'claude-opus-5',
      effort: EClaudeEffort.max,
    });
  });

  it('refuses an unknown engine, a missing model and a non-object', () => {
    expect(parseEngineConfig({ kind: 'gemini', model: 'g', effort: 'high' })).toBeNull();
    expect(parseEngineConfig({ kind: EEngine.codex, effort: 'high' })).toBeNull();
    expect(parseEngineConfig('claude')).toBeNull();
  });
});

describe('roleLabel', () => {
  it('spells a role for humans', () => {
    expect(roleLabel(EThreadRole.plan_review)).toBe('plan review');
  });

  it('leaves a single-word role alone', () => {
    expect(roleLabel(EThreadRole.builder)).toBe('builder');
  });

  it('never leaves an underscore on screen', () => {
    for (const role of ROLES) {
      expect(roleLabel(role)).not.toContain('_');
    }
  });
});
