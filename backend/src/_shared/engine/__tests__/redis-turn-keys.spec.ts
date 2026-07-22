import { describe, expect, it } from 'vitest';
import { turnKeys } from '../redis-turn-keys';

describe('turnKeys', () => {
  it('namespaces all three per-turn streams under the turn id', () => {
    expect(turnKeys('abc')).toEqual({
      spec: 'turn:abc:spec',
      events: 'turn:abc:events',
      input: 'turn:abc:input',
    });
  });
});
