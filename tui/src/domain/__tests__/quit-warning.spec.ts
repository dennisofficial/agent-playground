import { describe, expect, it } from 'bun:test';
import { quitWarning } from '../quit-warning.js';

/**
 * The sentence ctrl+c arms. It is the ONLY warning a human gets before a dev server dies, so the
 * cases that matter most are the ones where the count that is zero is the agents.
 */
describe('quitWarning', () => {
  it('is null when quitting costs nothing, so the first ctrl+c quits', () => {
    expect(quitWarning({ agents: 0, services: 0 })).toBeNull();
  });

  it('names agents alone, as it did before services existed', () => {
    expect(quitWarning({ agents: 1, services: 0 })).toBe('1 agent still working');
    expect(quitWarning({ agents: 3, services: 0 })).toBe('3 agents still working');
  });

  it('arms for a service with nothing working — the case the old warning missed', () => {
    expect(quitWarning({ agents: 0, services: 1 })).toBe('1 service running');
    expect(quitWarning({ agents: 0, services: 2 })).toBe('2 services running');
  });

  it('says both, agents first, because the turn is the thing you lose work in', () => {
    expect(quitWarning({ agents: 2, services: 1 })).toBe(
      '2 agents still working · 1 service running',
    );
  });

  it('ignores negative or fractional counts rather than rendering them', () => {
    expect(quitWarning({ agents: -1, services: 0 })).toBeNull();
  });
});
