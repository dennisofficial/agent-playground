import { investigationConfidence } from './confidence-check';

describe('investigationConfidence', () => {
  it('reads the trailer confidence value (each level)', () => {
    for (const level of ['high', 'medium', 'low'] as const) {
      const report = `Some answer.\n\nConfidence: ${level} — found it.\nCouldn't verify: none`;
      expect(investigationConfidence(report)).toBe(level);
    }
  });

  it('is case-insensitive and tolerates markdown/punctuation', () => {
    expect(investigationConfidence('… **Confidence:** Low.')).toBe('low');
    expect(investigationConfidence('CONFIDENCE: HIGH')).toBe('high');
  });

  it('takes the LAST marker (the trailer wins over a mid-report mention)', () => {
    const report =
      'I had low confidence at first.\nConfidence: medium — verified the path.';
    expect(investigationConfidence(report)).toBe('medium');
  });

  it('returns null when there is no marker (callers fail safe = no escalation)', () => {
    expect(investigationConfidence('Just a plain answer, no trailer.')).toBeNull();
    expect(investigationConfidence('my confidence is shaky')).toBeNull(); // not the marker format
  });
});
