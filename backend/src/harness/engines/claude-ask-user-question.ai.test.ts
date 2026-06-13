import type { EnvService } from '@core/config/env/env.service';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeEngine } from './claude.engine';
import type { WorkerEvent } from './worker-engine.port';

/**
 * Acceptance probe (real LLM) for AskUserQuestion on a plan turn — the assumption gating the
 * planning Q&A loop:
 *   - with 'AskUserQuestion' in the `tools` array (and settingSources: []), the headless CLI
 *     actually surfaces the tool and the model uses it when a task forces a fork;
 *   - the engine's capture-and-deny ends the turn (the model honors "end your turn NOW" instead of
 *     looping or answering itself), with the questions returned to the runner;
 *   - resuming the session with answers proceeds to a plan WITHOUT re-asking.
 * Runs only under `pnpm test:ai`.
 */
describe('ClaudeEngine AskUserQuestion on a plan turn (real LLM)', () => {
  it('asks at a forced fork, ends the turn on the deny, and plans after answers without re-asking', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const env = {
      get: (k: string) =>
        k === 'WORKER_MODEL' ? 'claude-haiku-4-5-20251001' : undefined,
    } as unknown as EnvService;
    const engine = new ClaudeEngine(sdk, env);

    const dir = await realpath(await mkdtemp(join(tmpdir(), 'ask-probe-')));
    const calcBefore = 'export const add = (a: number, b: number) => a + b;\n';
    await writeFile(join(dir, 'calc.ts'), calcBefore);

    const events: WorkerEvent[] = [];
    try {
      // Turn 1: a task with a genuine fork the model cannot resolve from the codebase, and an
      // explicit instruction to ask — probing the affordance, not the model's judgment.
      const first = await engine.run({
        task: 'Plan adding a divide function to calc.ts. The error-handling behavior for division by zero is NOT decided yet (throw vs return null vs return Infinity) and you must NOT pick one yourself: ask which via your AskUserQuestion tool before writing the plan.',
        cwd: dir,
        systemPrompt:
          'You are a careful planning agent. When a decision genuinely blocks your plan, ask via AskUserQuestion.',
        agentId: 'test',
        mode: 'plan',
        onEvent: (e) => events.push(e),
      });

      console.log('[ask-probe] questions:', JSON.stringify(first.questions));
      console.log('[ask-probe] result:', first.result.slice(0, 800));

      // The model used the tool and the engine captured the fork.
      expect(
        events.some((e) => e.kind === 'tool' && e.name === 'AskUserQuestion'),
      ).toBe(true);
      expect(first.questions?.length).toBeGreaterThan(0);
      expect(first.questions![0].options.length).toBeGreaterThan(1);
      expect(first.sessionId).toBeTruthy();
      // The turn ENDED on the deny (run() returned) and nothing executed.
      expect(await readFile(join(dir, 'calc.ts'), 'utf8')).toBe(calcBefore);

      // Turn 2: resume with the answer — it should produce a plan and NOT ask again.
      const askEventsBefore = events.filter(
        (e) => e.kind === 'tool' && e.name === 'AskUserQuestion',
      ).length;
      const second = await engine.run({
        task: 'Answer: division by zero should THROW a RangeError. Now finish the plan (2-3 steps). Planning only — do not implement.',
        cwd: dir,
        systemPrompt:
          'You are a careful planning agent. When a decision genuinely blocks your plan, ask via AskUserQuestion.',
        agentId: 'test',
        sessionId: first.sessionId,
        mode: 'plan',
        onEvent: (e) => events.push(e),
      });

      console.log('[ask-probe] plan:', second.result.slice(0, 1200));
      const askEventsAfter = events.filter(
        (e) => e.kind === 'tool' && e.name === 'AskUserQuestion',
      ).length;
      expect(askEventsAfter).toBe(askEventsBefore); // no re-ask
      expect(second.questions).toBeUndefined();
      expect(second.result.toLowerCase()).toContain('divide');
      expect(second.result.toLowerCase()).toContain('rangeerror');
      expect(await readFile(join(dir, 'calc.ts'), 'utf8')).toBe(calcBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
