import type { EnvService } from '@core/config/env/env.service';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeEngine } from './claude.engine';
import type { WorkerEvent } from './worker-engine.port';

/**
 * Acceptance test (real LLM) for ClaudeEngine's NATIVE plan mode — the probe that gated its
 * adoption (plan: jobs → sessions redesign). Validated findings it locks in:
 *   - under `permissionMode: 'plan'`, read-only tools (Read/Glob/Grep) actually execute — the
 *     SDK doc's "no execution of tools" is wrong for reads;
 *   - the CLI writes the plan file internally (never reaches canUseTool) and then calls
 *     ExitPlanMode with the FULL plan in its input — which the engine captures while DENYING the
 *     call, so a headless plan turn can never roll into execution;
 *   - the engine returns the captured plan as the turn's report, and the worktree stays untouched.
 * Runs only under `pnpm test:ai`.
 */
describe('ClaudeEngine native plan mode (real LLM)', () => {
  it('plans read-only, captures the full plan, and never executes', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const env = {
      get: (k: string) =>
        k === 'WORKER_MODEL' ? 'claude-haiku-4-5-20251001' : undefined,
    } as unknown as EnvService;
    const engine = new ClaudeEngine(sdk, env);

    const dir = await realpath(await mkdtemp(join(tmpdir(), 'plan-probe-')));
    const calcBefore = 'export const add = (a: number, b: number) => a + b;\n';
    await writeFile(join(dir, 'calc.ts'), calcBefore);

    const events: WorkerEvent[] = [];
    try {
      const { result, sessionId } = await engine.run({
        task: 'Read calc.ts, then produce a short plan (2-3 steps) for adding a subtract function. Planning only — do not implement.',
        cwd: dir,
        systemPrompt: 'You are a careful planning agent.',
        agentId: 'test',
        mode: 'plan',
        onEvent: (e) => events.push(e),
      });

      console.log('[plan-probe] result:', result.slice(0, 1500));
      console.log(
        '[plan-probe] dir after:',
        JSON.stringify(await readdir(dir)),
      );

      // The report is the substantive plan (captured at the ExitPlanMode denial), not a
      // "your plan has been recorded" closing summary.
      expect(result.toLowerCase()).toContain('subtract');
      expect(result.length).toBeGreaterThan(200);
      expect(sessionId).toBeTruthy();
      // Read-only exploration ran under native plan mode.
      expect(events.some((e) => e.kind === 'tool' && e.name === 'Read')).toBe(
        true,
      );
      // Nothing executed: the worktree is byte-identical.
      expect(await readFile(join(dir, 'calc.ts'), 'utf8')).toBe(calcBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
