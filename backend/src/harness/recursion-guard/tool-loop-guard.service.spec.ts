import { RunnableLambda } from '@langchain/core/runnables';
import type { EnvService } from '@core/config/env/env.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import {
  ToolLoopGuardService,
  type ToolLoopObservation,
} from './tool-loop-guard.service';
import { makeEmployee } from '@harness/employees/employee.testing';

/**
 * ToolLoopGuardService unit tests. The Haiku model is faked with RunnableLambda (same pattern as
 * recursion-guard.service.spec.ts) — tests assert the verdict mapping, fail-open behaviour, the
 * disabled path, and the threshold helper without any real LLM calls.
 */

const BOT = makeEmployee({
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
});

const OBS: ToolLoopObservation = {
  toolName: 'close_session',
  args: '{"id":"s-1"}',
  results: ['ok: closed', 'ok: closed', 'ok: closed'],
};

/** Minimal EnvService double. `enabled` defaults to undefined (on). */
function fakeEnv(
  opts: { enabled?: boolean; threshold?: number } = {},
): EnvService {
  return {
    get: (key: string): unknown => {
      if (key === 'TOOL_LOOP_GUARD_ENABLED')
        return opts.enabled === undefined ? undefined : opts.enabled;
      if (key === 'TOOL_LOOP_GUARD_THRESHOLD')
        return opts.threshold ?? undefined;
      return undefined;
    },
  } as unknown as EnvService;
}

/** Build a service whose model emits a fixed structured response. */
function buildService(
  modelOutput: () => { verdict: 'progressing' | 'stuck'; reasoning: string },
): ToolLoopGuardService {
  const models = {
    buildGuardModel: () => ({
      withStructuredOutput: () =>
        RunnableLambda.from(() => ({
          raw: { usage_metadata: null },
          parsed: modelOutput(),
        })),
    }),
  } as unknown as ChatModelFactory;
  return new ToolLoopGuardService(models, fakeEnv());
}

describe('ToolLoopGuardService', () => {
  describe('detect — model responses', () => {
    it('returns progressing for a legitimate poll/retry loop', async () => {
      const svc = buildService(() => ({
        verdict: 'progressing',
        reasoning: 'polling an async result that changes',
      }));
      const result = await svc.detect(BOT, OBS);
      expect(result.verdict).toBe('progressing');
      expect(result.reasoning).toBe('polling an async result that changes');
    });

    it('returns stuck and surfaces reasoning + usage when a no-progress loop is detected', async () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () =>
            RunnableLambda.from(() => ({
              raw: { usage_metadata: { input_tokens: 33, output_tokens: 6 } },
              parsed: {
                verdict: 'stuck',
                reasoning: 'already closed; re-issued identically',
              },
            })),
        }),
      } as unknown as ChatModelFactory;
      const svc = new ToolLoopGuardService(models, fakeEnv());

      const result = await svc.detect(BOT, OBS);

      expect(result.verdict).toBe('stuck');
      expect(result.reasoning).toBe('already closed; re-issued identically');
      expect(result.usage).toEqual({ input: 33, output: 6 });
    });

    it('fails open (progressing) when the model throws', async () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () =>
            RunnableLambda.from(() => {
              throw new Error('model unavailable');
            }),
        }),
      } as unknown as ChatModelFactory;
      const svc = new ToolLoopGuardService(models, fakeEnv());

      const result = await svc.detect(BOT, OBS);

      expect(result.verdict).toBe('progressing');
      expect(result.reasoning).toBeUndefined();
    });
  });

  describe('disabled path', () => {
    it('returns progressing immediately without a model call when TOOL_LOOP_GUARD_ENABLED=false', async () => {
      let modelCalled = false;
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () =>
            RunnableLambda.from(() => {
              modelCalled = true;
              return {
                raw: { usage_metadata: null },
                parsed: { verdict: 'stuck', reasoning: 'would fire' },
              };
            }),
        }),
      } as unknown as ChatModelFactory;
      const svc = new ToolLoopGuardService(models, fakeEnv({ enabled: false }));

      const result = await svc.detect(BOT, OBS);

      expect(result.verdict).toBe('progressing');
      expect(modelCalled).toBe(false);
    });
  });

  describe('isEnabled / threshold helpers', () => {
    it('isEnabled is true by default (env key absent)', () => {
      const svc = buildService(() => ({
        verdict: 'progressing',
        reasoning: '',
      }));
      expect(svc.isEnabled()).toBe(true);
    });

    it('isEnabled is false when TOOL_LOOP_GUARD_ENABLED=false', () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () => RunnableLambda.from(() => {}),
        }),
      } as unknown as ChatModelFactory;
      const svc = new ToolLoopGuardService(models, fakeEnv({ enabled: false }));
      expect(svc.isEnabled()).toBe(false);
    });

    it('threshold returns 3 by default', () => {
      const svc = buildService(() => ({
        verdict: 'progressing',
        reasoning: '',
      }));
      expect(svc.threshold()).toBe(3);
    });

    it('threshold returns the configured value when TOOL_LOOP_GUARD_THRESHOLD is set', () => {
      const models = {
        buildGuardModel: () => ({
          withStructuredOutput: () => RunnableLambda.from(() => {}),
        }),
      } as unknown as ChatModelFactory;
      const svc = new ToolLoopGuardService(models, fakeEnv({ threshold: 5 }));
      expect(svc.threshold()).toBe(5);
    });
  });
});
