/**
 * R3: `brain-llm.ts` now has only `triage()` (grill + parseGrillArgs deleted). These are placeholder
 * type-check tests to ensure the module still exports and compiles correctly.
 */
import { describe, expect, it } from 'vitest';
import { ATLAS_BRAIN_LLM, AnthropicBrainLlm } from './brain-llm';

describe('brain-llm (triage only after R3)', () => {
  it('exports ATLAS_BRAIN_LLM token', () => {
    expect(ATLAS_BRAIN_LLM).toBeDefined();
    expect(typeof ATLAS_BRAIN_LLM).toBe('symbol');
  });

  it('AnthropicBrainLlm constructs without a real key (lazy)', () => {
    const llm = new AnthropicBrainLlm(
      async () => undefined,
      () => undefined,
    );
    expect(llm).toBeDefined();
    expect(typeof llm.triage).toBe('function');
  });

  it('triage returns undefined when no API key is configured', async () => {
    const llm = new AnthropicBrainLlm(
      async () => undefined, // no key
      () => undefined,
    );
    const result = await llm.triage({ kind: 'event', body: 'test' });
    expect(result).toBeUndefined();
  });
});
