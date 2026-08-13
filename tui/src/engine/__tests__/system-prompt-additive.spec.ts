import { describe, expect, it } from 'bun:test';
import { buildSystemPrompt } from '../../domain/system-prompt.js';
import { claudeOptions } from '../claude-options.js';

/**
 * Atlas's system prompt is an ADDITION to Claude Code's, never a replacement.
 *
 * A bare string in the SDK's `systemPrompt` is a *custom* prompt and drops the `claude_code` preset
 * entirely. Atlas's own prompt is three short sections about the harness — the envelope vocabulary,
 * the canary, the phase brief — and none of them says anything about how to use `Edit`, how to read
 * a repository, or what the working directory is. Handing the agent those three sections INSTEAD of
 * the preset takes the coding agent away and leaves the etiquette.
 *
 * The failure is quiet, which is the whole reason this file exists: a session with no preset still
 * answers, still calls tools, and only degrades — so nothing throws and nothing goes red.
 */

const RUN = {
  prompt: 'hello',
  cwd: '/repo',
  model: 'claude-opus-5',
  env: {},
  onEvent: (): void => undefined,
};

/** The preset object, narrowed. A string here would BE the bug, so the guard is the assertion. */
function presetOf(systemPrompt: ReturnType<typeof claudeOptions>['systemPrompt']): {
  type: 'preset';
  preset: 'claude_code';
  append?: string | undefined;
  excludeDynamicSections?: boolean | undefined;
} {
  expect(typeof systemPrompt).toBe('object');
  expect(Array.isArray(systemPrompt)).toBe(false);
  if (typeof systemPrompt !== 'object' || systemPrompt === null || Array.isArray(systemPrompt)) {
    throw new Error('systemPrompt is not the preset form');
  }
  return systemPrompt;
}

describe('the system prompt is additive', () => {
  it('asks for the claude_code preset and appends Atlas, rather than replacing it', () => {
    const brief = buildSystemPrompt({ brief: 'Chart the territory.' });
    const prompt = presetOf(claudeOptions({ ...RUN, systemPrompt: brief }).systemPrompt);

    expect(prompt.type).toBe('preset');
    expect(prompt.preset).toBe('claude_code');
    expect(prompt.append).toBe(brief);
  });

  /**
   * The regression that motivated the change, stated as the shape rather than as the symptom: a
   * string is a custom prompt, and there is no other way for the SDK to read one.
   */
  it('never sends a bare string, which is what would drop the preset', () => {
    for (const systemPrompt of [undefined, '', '   ', buildSystemPrompt()]) {
      expect(typeof claudeOptions({ ...RUN, systemPrompt }).systemPrompt).not.toBe('string');
    }
  });

  /**
   * Nothing to add is the preset ALONE — not an absent option, and not an empty `append`. Whitespace
   * counts as nothing: `buildSystemPrompt` joins sections, so a brief that is only blank lines would
   * otherwise append a couple of newlines and call it an instruction.
   */
  it('appends nothing when there is nothing to say, and still asks for the preset', () => {
    for (const systemPrompt of [undefined, '', '   \n  ']) {
      const prompt = presetOf(claudeOptions({ ...RUN, systemPrompt }).systemPrompt);
      expect(prompt.preset).toBe('claude_code');
      expect(prompt.append).toBeUndefined();
    }
  });

  /**
   * `excludeDynamicSections` moves the cwd/git/memory context out of the system prompt and into the
   * first user message, to win a cross-user cache prefix. Atlas is one user on one machine — there is
   * no fleet to share a prefix with — and it would make exactly the context a worktree-relocating
   * harness most needs the agent to trust the least authoritative thing in the window.
   */
  it('keeps the preset dynamic sections, which are where cwd and git status live', () => {
    const prompt = presetOf(claudeOptions(RUN).systemPrompt);
    expect(prompt.excludeDynamicSections).toBeUndefined();
  });
});
