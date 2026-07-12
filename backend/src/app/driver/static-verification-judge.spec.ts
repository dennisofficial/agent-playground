import { describe, expect, it } from 'vitest';
import {
  AnthropicStaticVerificationJudge,
  JudgeStaticVerificationChain,
} from './static-verification-judge';

describe('AnthropicStaticVerificationJudge', () => {
  it('with no Anthropic key available, judge() resolves undefined (conservative-default path, no network)', async () => {
    const judge = new AnthropicStaticVerificationJudge(async () => undefined);
    const verdict = await judge.judge({
      terminalRecordSummary: 'summary: did the thing',
      changedFiles: ['src/foo.ts'],
      lockedDecisionsSummary: '(none)',
    });
    expect(verdict).toBeUndefined();
  });
});

describe('JudgeStaticVerificationChain.Schema', () => {
  it('parses a valid adequate verdict', () => {
    const parsed = JudgeStaticVerificationChain.Schema.parse({
      staticChecksAdequate: true,
      reason: 'ok',
    });
    expect(parsed).toEqual({ staticChecksAdequate: true, reason: 'ok' });
  });

  it('parses a valid inadequate verdict with missingChecks', () => {
    const parsed = JudgeStaticVerificationChain.Schema.parse({
      staticChecksAdequate: false,
      reason: 'x',
      missingChecks: 'typecheck',
    });
    expect(parsed).toEqual({
      staticChecksAdequate: false,
      reason: 'x',
      missingChecks: 'typecheck',
    });
  });

  it('missingChecks is optional — a valid object without it still parses', () => {
    const parsed = JudgeStaticVerificationChain.Schema.parse({
      staticChecksAdequate: true,
      reason: 'no applicable checks skipped',
    });
    expect(parsed.missingChecks).toBeUndefined();
  });
});

describe('JudgeStaticVerificationChain.SYSTEM', () => {
  it('is a non-empty string naming the static-check contract', () => {
    expect(JudgeStaticVerificationChain.SYSTEM.length).toBeGreaterThan(0);
    expect(JudgeStaticVerificationChain.SYSTEM).toContain('typecheck');
    expect(JudgeStaticVerificationChain.SYSTEM).toContain(
      'staticChecksAdequate',
    );
  });
});
