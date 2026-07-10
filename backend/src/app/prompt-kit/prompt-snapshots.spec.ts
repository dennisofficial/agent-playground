import { describe, expect, it } from 'vitest';
import { Agent } from './agent';
import { renderAgentPrompt } from './assemble';
import { AGENT_PROMPTS } from './preview';

/**
 * Full-matrix golden-snapshot baseline: ONE `.txt` snapshot per `AGENT_PROMPTS` entry (the dev-only preview
 * catalog, made the single source of truth for the Agent×ctx matrix). Every snapshot captures CURRENT
 * output verbatim — a regression pass, not a spec of intent (behavioral assertions live in
 * `prompt-kit.spec.ts` and the group specs).
 */
describe('prompt-kit / full-matrix golden snapshots', () => {
  it('covers every Agent enum value at least once', () => {
    const covered = new Set(AGENT_PROMPTS.map((e) => e.agent));
    for (const agent of Object.values(Agent)) {
      expect(covered.has(agent), String(agent)).toBe(true);
    }
  });

  for (const entry of AGENT_PROMPTS) {
    it(`renders "${entry.id}" (${entry.agent})`, async () => {
      const out = renderAgentPrompt(entry.agent, entry.ctx);
      await expect(out).toMatchFileSnapshot(`./__snapshots__/${entry.id}.txt`);
    });
  }
});
