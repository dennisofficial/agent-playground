import { describe, expect, it, vi } from 'vitest';
import { AnthropicSkillNudgeSelector } from './skill-nudge-llm';

const skills = [
  { name: 'a', description: 'skill a' },
  { name: 'b', description: 'skill b' },
];

describe('AnthropicSkillNudgeSelector', () => {
  it('no key → resolves to [], never invokes the chain factory', async () => {
    const chainFactory = vi.fn();
    const selector = new AnthropicSkillNudgeSelector(
      async () => undefined,
      chainFactory,
    );
    const result = await selector.select({ context: 'ctx', skills });
    expect(result).toEqual([]);
    expect(chainFactory).not.toHaveBeenCalled();
  });

  it('passes through relevant entries unchanged when their names are known', async () => {
    const chainFactory = () => ({
      invoke: async () => ({
        relevant: [
          { name: 'a', reason: 'r' },
          { name: 'b', reason: 'r2' },
        ],
      }),
    });
    const selector = new AnthropicSkillNudgeSelector(
      async () => 'fake-key',
      chainFactory as any,
    );
    const result = await selector.select({ context: 'ctx', skills });
    expect(result).toEqual([
      { name: 'a', reason: 'r' },
      { name: 'b', reason: 'r2' },
    ]);
  });

  it('the chain throwing → resolves to [] (never throws)', async () => {
    const chainFactory = () => ({
      invoke: async () => {
        throw new Error('boom');
      },
    });
    const selector = new AnthropicSkillNudgeSelector(
      async () => 'fake-key',
      chainFactory as any,
    );
    const result = await selector.select({ context: 'ctx', skills });
    expect(result).toEqual([]);
  });

  it('filters out a hallucinated skill name not present in the input skills list', async () => {
    const chainFactory = () => ({
      invoke: async () => ({
        relevant: [
          { name: 'a', reason: 'r' },
          { name: 'not-a-real-skill', reason: 'made up' },
        ],
      }),
    });
    const selector = new AnthropicSkillNudgeSelector(
      async () => 'fake-key',
      chainFactory as any,
    );
    const result = await selector.select({ context: 'ctx', skills });
    expect(result).toEqual([{ name: 'a', reason: 'r' }]);
  });

  it('normalizes selected reasons to one line before persisting', async () => {
    const chainFactory = () => ({
      invoke: async () => ({
        relevant: [{ name: 'a', reason: 'line one\nline two' }],
      }),
    });
    const selector = new AnthropicSkillNudgeSelector(
      async () => 'fake-key',
      chainFactory as any,
    );
    const result = await selector.select({ context: 'ctx', skills });
    expect(result).toEqual([{ name: 'a', reason: 'line one line two' }]);
  });
});
