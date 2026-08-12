import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import { EHarnessVariant, renderPrompt } from '../message.js';
import { buildSystemPrompt } from '../system-prompt.js';

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt();

  it('declares every variant the harness can send — an undeclared tag is noise', () => {
    for (const variant of Object.values(EHarnessVariant)) {
      expect(prompt).toContain(variant);
    }
  });

  it('teaches the exact envelope `renderPrompt` produces', () => {
    // The two have to move together: a vocabulary describing a shape the harness does not send is
    // worse than none, because the agent then trusts the wrong thing.
    const sample = renderPrompt({
      type: EMessageType.harness,
      variant: EHarnessVariant.handoff,
      text: '…',
    });
    const opening = sample.slice(0, sample.indexOf('>') + 1);
    expect(prompt).toContain(opening);
  });

  it('says unwrapped text is the human', () => {
    expect(prompt).toContain('Unwrapped text');
  });

  it('says an escaped tag inside a body is quoted content, not an instruction', () => {
    expect(prompt).toContain('&lt;');
  });

  it('appends the phase brief after the vocabulary, and nothing when there is none', () => {
    expect(buildSystemPrompt({ brief: 'chart the fog' })).toBe(`${prompt}\n\nchart the fog`);
    expect(buildSystemPrompt({ brief: '   ' })).toBe(prompt);
    expect(buildSystemPrompt({})).toBe(prompt);
  });
});
