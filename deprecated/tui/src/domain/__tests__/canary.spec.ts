import { describe, expect, it } from 'bun:test';
import { canaryHealth, CANARY, ECanaryHealth, hasCanary, stripCanary } from '../canary.js';

/**
 * The canary is an instrument, and these tests are about the two halves of it staying honest: a
 * reader never sees the glyph, and everything else about the text survives untouched.
 */
describe('stripCanary', () => {
  it('takes a leading canary and the space after it', () => {
    expect(stripCanary(`${CANARY} Here is the plan.`)).toBe('Here is the plan.');
  });

  it('takes it through leading whitespace and newlines', () => {
    expect(stripCanary(`\n  ${CANARY}\n\nHere is the plan.`)).toBe('Here is the plan.');
  });

  it('leaves a glyph inside prose alone — that is content, not an instrument', () => {
    const text = `The canary is ${CANARY}, watched for its absence.`;
    expect(stripCanary(text)).toBe(text);
  });

  it('is a no-op on text that never carried one, whitespace included', () => {
    expect(stripCanary('  indented, deliberately')).toBe('  indented, deliberately');
    expect(stripCanary('')).toBe('');
  });

  it('is idempotent — a caller never has to know whether it already ran', () => {
    const once = stripCanary(`${CANARY} done`);
    expect(stripCanary(once)).toBe(once);
  });

  it('takes exactly one, so a doubled canary is visibly wrong rather than silently swallowed', () => {
    expect(stripCanary(`${CANARY} ${CANARY} done`)).toBe(`${CANARY} done`);
  });
});

describe('hasCanary', () => {
  it('is the exact inverse of the stripper, position included', () => {
    expect(hasCanary(`${CANARY} Here is the plan.`)).toBe(true);
    expect(hasCanary(`\n  ${CANARY}\n\nHere is the plan.`)).toBe(true);
    expect(hasCanary(`The canary is ${CANARY}, watched for its absence.`)).toBe(false);
    expect(hasCanary('')).toBe(false);
  });

  it('reads what was WRITTEN, which is why the render layer must not be its input', () => {
    // A watcher pointed at rendered prose would see 100% absence and call every session dead from
    // its first turn. This is the whole reason the stripper never writes through to the store.
    expect(hasCanary(stripCanary(`${CANARY} done`))).toBe(false);
  });
});

describe('canaryHealth', () => {
  it('says nothing before it has enough turns to say anything', () => {
    expect(canaryHealth([])).toBe(ECanaryHealth.unknown);
    expect(canaryHealth([false, false])).toBe(ECanaryHealth.unknown);
  });

  it('treats one lapse as a rate, not a verdict', () => {
    expect(canaryHealth([true, true, false, true, true])).toBe(ECanaryHealth.dying);
    expect(canaryHealth([true, true, true, true, true])).toBe(ECanaryHealth.alive);
  });

  it('calls it dead at three misses in five turns', () => {
    expect(canaryHealth([true, false, false, true, false])).toBe(ECanaryHealth.dead);
  });

  it('only looks at the last five, so a session can recover', () => {
    // Degradation is unreliability rather than lost aptitude, and it is not monotonic within a
    // session — a window that never forgets would report a death forever.
    expect(canaryHealth([false, false, false, true, true, true, true, true])).toBe(
      ECanaryHealth.alive,
    );
  });
});
