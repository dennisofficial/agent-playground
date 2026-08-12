import { describe, expect, it } from 'bun:test';
import { EAtlasTool } from '../../domain/tool-surface.js';
import { claudeOptions } from '../claude-options.js';
import { NATIVE_TOOLS, NATIVE_TOOLS_OUT } from '../native-tools.js';

/**
 * The native todo tool is **disallowed, not merely unused**.
 *
 * Ticket 06 built the allowlist that makes it so; this file is the reason it matters. Atlas's task
 * list replaces the native one outright rather than sitting beside it, and "outright" is a claim
 * about the SDK options rather than about anybody's intentions: two checklists in one thread means
 * the visible one is not the one the agent is keeping.
 *
 * The native list also dies at session rotation, where Atlas's hangs off the thread — so a harness
 * built on `TodoWrite` would lose the plan at exactly the moment a successor needs it.
 */

/** Everything Claude ships for managing a plan. Named individually so a new arrival is noticed. */
const NATIVE_TASK_FAMILY = [
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
];

const RUN = {
  prompt: 'hello',
  cwd: '/repo',
  model: 'claude-opus-5',
  env: {},
  onEvent: (): void => undefined,
};

describe('the native task family is out', () => {
  it('is absent from the allowlist, and the allowlist is what `tools` sends', () => {
    const options = claudeOptions(RUN);
    const sent = new Set(Array.isArray(options.tools) ? options.tools : []);
    // `tools` is the lever. `allowedTools` is the auto-APPROVAL list — a short one there would leave
    // every native tool present and merely asking, which is how this gets accidentally undone.
    expect(sent.size).toBeGreaterThan(0);
    for (const name of NATIVE_TASK_FAMILY) {
      expect(NATIVE_TOOLS).not.toContain(name);
      expect(sent.has(name)).toBe(false);
    }
    expect(options.disallowedTools).toBeUndefined();
  });

  it('records WHY each one is out, without sending a denylist to the SDK', () => {
    for (const name of NATIVE_TASK_FAMILY) {
      expect(NATIVE_TOOLS_OUT[name]).toBeDefined();
      expect(NATIVE_TOOLS_OUT[name]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  /**
   * The split is by what a tool DOES, not by what it is called — `TaskOutput` and `TaskStop` share a
   * prefix with four excluded tools and belong to the fan-out family instead, which is in. Asserted
   * so that nobody later "tidies" this into a prefix match and silently removes fan-out.
   */
  it('does not exclude by name — the fan-out task tools stay in', () => {
    for (const name of ['Agent', 'TaskOutput', 'TaskStop']) {
      expect(NATIVE_TOOLS).toContain(name);
      expect(NATIVE_TOOLS_OUT[name]).toBeUndefined();
    }
  });

  // A sweep rather than a list, for the half where a rule CAN be written: nothing todo-shaped is in.
  it('lets no todo tool in under another name', () => {
    expect(NATIVE_TOOLS.filter((name) => /todo/i.test(name))).toEqual([]);
  });

  it('replaces them with three Atlas tools and no fourth', () => {
    // The trade the exclusion buys: create, update and list, hanging off the thread. No `task_get`
    // — a checklist row is one line, so a getter could only return what the list already shows.
    expect(Object.values(EAtlasTool)).toContain(EAtlasTool.task_create);
    expect(Object.values(EAtlasTool)).toContain(EAtlasTool.task_update);
    expect(Object.values(EAtlasTool)).toContain(EAtlasTool.task_list);
    expect(Object.values(EAtlasTool)).not.toContain('task_get');
  });
});
