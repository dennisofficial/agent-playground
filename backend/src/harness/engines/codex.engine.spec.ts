import type { EnvService } from '@core/config/env/env.service';
import { CodexEngine } from './codex.engine';
import type { RunWorkerArgs } from './worker-engine.port';

/**
 * Token-usage extraction from `turn.completed` events. The stub Codex SDK drives the event stream
 * directly so no subprocess runs — pins the `turn.completed` case and the `IWorkerUsage` mapping.
 */

/** Build a fake Codex SDK where `runStreamed` emits the given events in order. */
function makeStubCodex(
  events: Array<Record<string, unknown>>,
  threadId = 'thread-stub-1',
) {
  const thread = {
    id: threadId,
    runStreamed(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _input: string,
    ) {
      // eslint-disable-next-line @typescript-eslint/require-await
      const eventGen = async function* () {
        yield { type: 'thread.started', thread_id: threadId };
        for (const e of events) yield e;
      };
      return { events: eventGen() };
    },
  };
  const client = {
    startThread: () => thread,
    resumeThread: () => thread,
  };

  const sdk = {
    Codex: class {
      constructor() {
        Object.assign(this, client);
      }
    },
  } as unknown as typeof import('@openai/codex-sdk');

  return sdk;
}

function makeEngine(sdk: unknown) {
  const env = {
    get: (k: string) => (k === 'AGENT_HOME_ROOT' ? '/tmp/homes' : undefined),
  } as unknown as EnvService;
  return new CodexEngine(sdk as never, env);
}

const baseArgs = (mode: 'plan' | 'execute' = 'execute'): RunWorkerArgs => ({
  task: 'do the thing',
  cwd: '/tmp/wt',
  systemPrompt: 'worker prompt',
  agentId: 'test-agent',
  mode,
  onEvent: () => {},
});

describe('CodexEngine — token usage extraction', () => {
  it('extracts usage from turn.completed event', async () => {
    const sdk = makeStubCodex([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Done.' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 800,
          cached_input_tokens: 400,
          output_tokens: 120,
          reasoning_output_tokens: 30,
        },
      },
    ]);
    const out = await makeEngine(sdk).run({
      ...baseArgs(),
      model: 'codex-mini',
    });
    expect(out.usage).toBeDefined();
    expect(out.usage!.inputTokens).toBe(800);
    expect(out.usage!.outputTokens).toBe(120);
    expect(out.usage!.cacheReadTokens).toBe(400);
    expect(out.usage!.reasoningTokens).toBe(30);
    expect(out.usage!.costUsd).toBeUndefined(); // Codex has no server-side cost
    expect(out.usage!.model).toBe('codex-mini');
  });

  it('omits cacheReadTokens/reasoningTokens when zero', async () => {
    const sdk = makeStubCodex([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Done.' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 200,
          cached_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    const out = await makeEngine(sdk).run(baseArgs());
    expect(out.usage!.inputTokens).toBe(200);
    expect(out.usage!.cacheReadTokens).toBeUndefined();
    expect(out.usage!.reasoningTokens).toBeUndefined();
  });

  it('returns undefined usage when no turn.completed fires', async () => {
    const sdk = makeStubCodex([
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Done.' },
      },
    ]);
    const out = await makeEngine(sdk).run(baseArgs());
    expect(out.usage).toBeUndefined();
  });

  it('accumulates usage from multiple turn.completed events', async () => {
    const sdk = makeStubCodex([
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 300,
          cached_input_tokens: 100,
          output_tokens: 40,
          reasoning_output_tokens: 10,
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
    ]);
    const out = await makeEngine(sdk).run(baseArgs());
    expect(out.usage!.inputTokens).toBe(500);
    expect(out.usage!.outputTokens).toBe(70);
    expect(out.usage!.cacheReadTokens).toBe(150);
    expect(out.usage!.reasoningTokens).toBe(15);
  });
});
