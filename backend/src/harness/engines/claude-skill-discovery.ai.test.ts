import type { EnvService } from '@core/config/env/env.service';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineHomeProvisioner } from '../skills/engine-home-provisioner.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ClaudeEngine } from './claude.engine';
import { EWorkerEngineName, type WorkerEvent } from './worker-engine.port';

/**
 * Acceptance probe (real LLM) for the load-bearing Phase 3 assumption: a skill SYMLINKED into the
 * employee's isolated <CLAUDE_CONFIG_DIR>/skills (as the provisioner does) is DISCOVERED and
 * invocable even though the engine runs `settingSources: []` (SDK isolation mode). If this fails,
 * the symlink approach doesn't work in isolation mode and we must fall back to the `plugins` option.
 *
 * Auth: passes `ANTHROPIC_API_KEY` from the env as the run's apiKey (the test run loads it from
 * `.env.personal`; the harness proper resolves a per-tenant key from the DB instead). Skips with a
 * warning when no key is present. Runs only under `pnpm test:ai`.
 */
describe('ClaudeEngine skill discovery under settingSources:[] (real LLM)', () => {
  it('discovers + invokes a symlinked skill (the Skill tool fires)', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('  ANTHROPIC_API_KEY not in env — skipping skill-discovery probe');
      return;
    }

    const base = await realpath(await mkdtemp(join(tmpdir(), 'skill-home-')));
    const skillDir = join(base, 'src-skill', 'code-review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: code-review\ndescription: Review a diff for correctness before shipping. Use whenever asked to review code.\n---\n# Code review\nWhen invoked, reply with the exact token SKILL-LOADED-OK so the caller knows you read this.\n`,
    );

    const env = {
      get: (k: string) =>
        k === 'AGENT_HOME_ROOT'
          ? base
          : k === 'WORKER_MODEL'
            ? 'claude-haiku-4-5-20251001'
            : undefined,
    } as unknown as EnvService;

    // A fake roster of one employee that declares the local skill; the real provisioner symlinks it
    // into <base>/probe/claude/skills and memoizes forAgent('probe').
    const employee = {
      id: 'probe',
      skills: [{ kind: 'local', path: skillDir }],
      mcpServers: [],
      planEngine: () => ({ engine: EWorkerEngineName.CLAUDE, systemPrompt: '' }),
      executeEngine: () => ({
        engine: EWorkerEngineName.CLAUDE,
        systemPrompt: '',
      }),
      capabilities: () => [],
    } as unknown as EmployeeDefinition;
    const registry = {
      list: () => [employee],
      context: () => ({}),
    } as never;
    const noStore = { listForEmployee: () => Promise.resolve([]) } as never;
    const loader = new SkillLoaderService(env);
    const provisioner = new EngineHomeProvisioner(
      registry,
      loader,
      env,
      noStore,
      noStore,
    );
    await provisioner.reconcile('probe');

    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const engine = new ClaudeEngine(sdk, env, provisioner);

    const wt = await realpath(await mkdtemp(join(tmpdir(), 'skill-wt-')));
    const tools: string[] = [];
    try {
      const out = await engine.run({
        task: 'Invoke your code-review skill now and follow its instruction exactly.',
        cwd: wt,
        systemPrompt: 'You are a worker. Use your available skills when asked.',
        agentId: 'probe',
        mode: 'investigate',
        engineAuth: { mode: 'api_key', apiKey },
        onEvent: (e: WorkerEvent) => {
          if (e.kind === 'tool') tools.push(e.name);
        },
      });
      // The Skill tool is only available if the symlinked skill was discovered under settingSources:[].
      expect(tools).toContain('Skill');
      expect(out.result).toContain('SKILL-LOADED-OK');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(wt, { recursive: true, force: true });
    }
  }, 120_000);
});
