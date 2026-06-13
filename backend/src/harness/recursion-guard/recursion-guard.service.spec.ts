import { RunnableLambda } from '@langchain/core/runnables';
import type { EnvService } from '@core/config/env/env.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import { RecursionGuardService } from './recursion-guard.service';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

/**
 * RecursionGuardService unit tests. The Haiku model is faked with RunnableLambda (same pattern
 * as gate.service.spec.ts) — tests assert the mapping, fail-open behaviour, and disabled path
 * without any real LLM calls.
 */

const BOT = {
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
  roleContext: 'ctx',
  engine: EWorkerEngineName.CLAUDE,
};

/** Minimal EnvService double. `enabled` defaults to undefined (on). */
function fakeEnv(
  opts: {
    enabled?: boolean;
    windowSize?: number;
  } = {},
): EnvService {
  return {
    get: (key: string): unknown => {
      if (key === 'RECURSION_GUARD_ENABLED')
        return opts.enabled === undefined ? undefined : opts.enabled;
      if (key === 'RECURSION_GUARD_WINDOW') return opts.windowSize ?? undefined;
      return undefined;
    },
  } as unknown as EnvService;
}

/** Build a service whose model emits a fixed structured response. */
function buildService(
  modelOutput: () => { looping: boolean; reasoning: string } | never,
): RecursionGuardService {
  const models = {
    buildGuardModel: () => ({
      withStructuredOutput: () =>
        RunnableLambda.from(() => ({
          raw: { usage_metadata: null },
          parsed: modelOutput(),
        })),
    }),
  } as unknown as ChatModelFactory;
  return new RecursionGuardService(models, fakeEnv());
}

describe('RecursionGuardService', () => {
  describe('detect — model responses', () => {
    it('returns looping: false for a healthy (non-repeating) window', async () => {
      const svc = buildService(() => ({
        looping: false,
        reasoning: 'distinct sequential steps',
      }));
      const result = await svc.detect(BOT, 'step 1\nstep 2\nstep 3');
      expect(result.looping).toBe(false);
      expect(result.reasoning).toBe('distinct sequential steps');
    });

    it('returns looping: true and surfaces reasoning when a loop is detected', async () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () =>
            RunnableLambda.from(() => ({
              raw: {
                usage_metadata: { input_tokens: 42, output_tokens: 8 },
              },
              parsed: { looping: true, reasoning: 'same status repeated 3×' },
            })),
        }),
      } as unknown as ChatModelFactory;
      const svc = new RecursionGuardService(models, fakeEnv());

      const result = await svc.detect(
        BOT,
        'still running\nstill running\nstill running',
      );

      expect(result.looping).toBe(true);
      expect(result.reasoning).toBe('same status repeated 3×');
      expect(result.usage).toEqual({ input: 42, output: 8 });
    });

    it('fails open (looping: false) when the model throws', async () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () =>
            RunnableLambda.from(() => {
              throw new Error('model unavailable');
            }),
        }),
      } as unknown as ChatModelFactory;
      const svc = new RecursionGuardService(models, fakeEnv());

      const result = await svc.detect(BOT, 'some window text');

      expect(result.looping).toBe(false);
      expect(result.reasoning).toBeUndefined();
    });
  });

  describe('disabled path', () => {
    it('returns looping: false immediately without a model call when RECURSION_GUARD_ENABLED=false', async () => {
      let modelCalled = false;
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () =>
            RunnableLambda.from(() => {
              modelCalled = true;
              return {
                raw: { usage_metadata: null },
                parsed: { looping: true, reasoning: 'would fire' },
              };
            }),
        }),
      } as unknown as ChatModelFactory;
      const svc = new RecursionGuardService(
        models,
        fakeEnv({ enabled: false }),
      );

      const result = await svc.detect(BOT, 'any window');

      expect(result.looping).toBe(false);
      expect(modelCalled).toBe(false);
    });
  });

  describe('isEnabled / windowSize helpers', () => {
    it('isEnabled is true by default (env key absent)', () => {
      const svc = buildService(() => ({ looping: false, reasoning: '' }));
      expect(svc.isEnabled()).toBe(true);
    });

    it('isEnabled is false when RECURSION_GUARD_ENABLED=false', () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () => RunnableLambda.from(() => {}),
        }),
      } as unknown as ChatModelFactory;
      const svc = new RecursionGuardService(
        models,
        fakeEnv({ enabled: false }),
      );
      expect(svc.isEnabled()).toBe(false);
    });

    it('windowSize returns 12 by default', () => {
      const svc = buildService(() => ({ looping: false, reasoning: '' }));
      expect(svc.windowSize()).toBe(12);
    });

    it('windowSize returns the configured value when RECURSION_GUARD_WINDOW is set', () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () => RunnableLambda.from(() => {}),
        }),
      } as unknown as ChatModelFactory;
      const svc = new RecursionGuardService(
        models,
        fakeEnv({ windowSize: 20 }),
      );
      expect(svc.windowSize()).toBe(20);
    });
  });
});
