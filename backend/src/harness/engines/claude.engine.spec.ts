import type { EnvService } from '@core/config/env/env.service';
import type { RunWorkerArgs } from './worker-engine.port';
import { ClaudeEngine } from './claude.engine';

/**
 * The AskUserQuestion capture seam, against a STUB SDK (no subprocess, no LLM): the stub's query()
 * drives the engine's canUseTool exactly the way the CLI would, so the deny-and-capture contract is
 * pinned here. Whether the real CLI surfaces AskUserQuestion headlessly under `tools` +
 * `settingSources: []` is probed by claude-ask-user-question.ai.test.ts.
 */

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: string; message?: string }>;

interface CapturedOptions {
  tools?: string[];
  canUseTool?: CanUseTool;
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which auth approach?',
      header: 'Auth',
      options: [
        { label: 'Cookie', description: 'reuse middleware' },
        { label: 'Token' },
      ],
      multiSelect: false,
    },
  ],
};

/** A stub SDK whose query() invokes `script(canUseTool)` then yields a success result. */
function stubSdk(
  script: (canUseTool: CanUseTool, options: CapturedOptions) => Promise<void>,
  result = 'closing summary',
  extraResultFields: Record<string, unknown> = {},
) {
  const captured: { options?: CapturedOptions } = {};
  const sdk = {
    query({ options }: { prompt: string; options: CapturedOptions }) {
      captured.options = options;
      return (async function* () {
        await script(options.canUseTool!, options);
        yield {
          type: 'result',
          subtype: 'success',
          result,
          session_id: 'engine-1',
          ...extraResultFields,
        };
      })();
    },
  };
  return { sdk, captured };
}

function makeEngine(sdk: unknown) {
  const env = { get: () => undefined } as unknown as EnvService;
  return new ClaudeEngine(sdk as never, env);
}

const baseArgs = (mode: 'plan' | 'execute'): RunWorkerArgs => ({
  task: 'do the thing',
  cwd: '/tmp/wt',
  systemPrompt: 'worker prompt',
  agentId: 'test',
  mode,
  onEvent: () => {},
});

describe('ClaudeEngine — AskUserQuestion capture', () => {
  it('plan turns expose AskUserQuestion (and ExitPlanMode); execute turns do not', async () => {
    const { sdk, captured } = stubSdk(async () => {});
    const engine = makeEngine(sdk);
    await engine.run(baseArgs('plan'));
    expect(captured.options?.tools).toContain('AskUserQuestion');
    expect(captured.options?.tools).toContain('ExitPlanMode');
    await engine.run(baseArgs('execute'));
    expect(captured.options?.tools).not.toContain('AskUserQuestion');
    expect(captured.options?.tools).not.toContain('ExitPlanMode');
  });

  it('captures and denies on a plan turn: questions returned, deny says relayed + end turn', async () => {
    let deny: { behavior: string; message?: string } | undefined;
    const { sdk } = stubSdk(async (canUseTool) => {
      deny = await canUseTool('AskUserQuestion', QUESTION_INPUT);
    });
    const engine = makeEngine(sdk);
    const out = await engine.run(baseArgs('plan'));

    expect(deny?.behavior).toBe('deny');
    expect(deny?.message).toContain('relayed');
    expect(deny?.message).toContain('not an error');
    expect(deny?.message).toContain('End your turn NOW');
    expect(out.questions).toEqual([
      {
        question: 'Which auth approach?',
        header: 'Auth',
        options: [
          { label: 'Cookie', description: 'reuse middleware' },
          { label: 'Token' },
        ],
      },
    ]);
    expect(out.result).toBe('closing summary');
  });

  it('dedupes re-asked questions across one turn', async () => {
    const { sdk } = stubSdk(async (canUseTool) => {
      await canUseTool('AskUserQuestion', QUESTION_INPUT);
      await canUseTool('AskUserQuestion', QUESTION_INPUT); // model ignored the deny
    });
    const out = await makeEngine(sdk).run(baseArgs('plan'));
    expect(out.questions).toHaveLength(1);
  });

  it('denies without capture on an execute turn', async () => {
    let deny: { behavior: string; message?: string } | undefined;
    const { sdk } = stubSdk(async (canUseTool) => {
      deny = await canUseTool('AskUserQuestion', QUESTION_INPUT);
    });
    const out = await makeEngine(sdk).run(baseArgs('execute'));
    expect(deny?.behavior).toBe('deny');
    expect(deny?.message).toContain('end-of-turn report');
    expect(out.questions).toBeUndefined();
  });

  it('a turn that asked AND exited plan mode returns both questions and planText', async () => {
    const { sdk } = stubSdk(async (canUseTool) => {
      await canUseTool('AskUserQuestion', QUESTION_INPUT);
      await canUseTool('ExitPlanMode', { plan: 'Half a plan.' });
    });
    const out = await makeEngine(sdk).run(baseArgs('plan'));
    expect(out.questions).toHaveLength(1);
    expect(out.planText).toBe('Half a plan.');
    expect(out.result).toBe('Half a plan.'); // plan still preferred as the summary
  });

  it('drops malformed question entries instead of failing the turn', async () => {
    const { sdk } = stubSdk(async (canUseTool) => {
      await canUseTool('AskUserQuestion', {
        questions: [
          null,
          { question: '' },
          { question: 'Real one?', options: [{ label: 'A' }, { nope: true }] },
        ],
      });
    });
    const out = await makeEngine(sdk).run(baseArgs('plan'));
    expect(out.questions).toEqual([
      { question: 'Real one?', options: [{ label: 'A' }] },
    ]);
  });
});

describe('ClaudeEngine — token usage extraction', () => {
  it('returns usage with cache tokens folded into inputTokens', async () => {
    const { sdk } = stubSdk(async () => {}, 'summary', {
      usage: {
        input_tokens: 600, // fresh only (SDK convention)
        output_tokens: 80,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 100,
      },
      total_cost_usd: 0.0055,
      modelUsage: { 'claude-sonnet-4-6': {} },
    });
    const out = await makeEngine(sdk).run(baseArgs('execute'));
    expect(out.usage).toBeDefined();
    // inputTokens = fresh + cacheRead + cacheWrite = 600 + 300 + 100 = 1000
    expect(out.usage!.inputTokens).toBe(1000);
    expect(out.usage!.outputTokens).toBe(80);
    expect(out.usage!.cacheReadTokens).toBe(300);
    expect(out.usage!.cacheWriteTokens).toBe(100);
    expect(out.usage!.costUsd).toBe(0.0055);
    expect(out.usage!.model).toBe('claude-sonnet-4-6');
  });

  it('returns usage without cache fields when cache counts are zero', async () => {
    const { sdk } = stubSdk(async () => {}, 'summary', {
      usage: {
        input_tokens: 500,
        output_tokens: 60,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.002,
      modelUsage: { 'claude-haiku-4-5-20251001': {} },
    });
    const out = await makeEngine(sdk).run(baseArgs('execute'));
    expect(out.usage!.inputTokens).toBe(500);
    expect(out.usage!.cacheReadTokens).toBeUndefined();
    expect(out.usage!.cacheWriteTokens).toBeUndefined();
    expect(out.usage!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to resolvedModel when modelUsage is empty', async () => {
    const { sdk } = stubSdk(async () => {}, 'summary', {
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: {},
    });
    // engine has no WORKER_MODEL env, so resolvedModel === undefined → model absent
    const out = await makeEngine(sdk).run(baseArgs('execute'));
    expect(out.usage!.model).toBeUndefined();
  });

  it('returns undefined usage when result has no usage field', async () => {
    const { sdk } = stubSdk(async () => {}, 'summary');
    const out = await makeEngine(sdk).run(baseArgs('execute'));
    expect(out.usage).toBeUndefined();
  });
});
