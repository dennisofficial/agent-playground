import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { Message } from '../message.js';
import { ESessionEndReason } from '../../generated/prisma/enums.js';
import { currentSessionOrdinal, seamLabel, withSeams, type SessionRef } from '../seam.js';

function message(id: string, sessionId: string, ordinal: number): Message {
  return {
    id,
    threadId: 'thread-1',
    sessionId,
    ordinal,
    payload: { type: EMessageType.assistant, text: id },
    createdAt: new Date(0),
  };
}

const SESSIONS: SessionRef[] = [
  { id: 's1', ordinal: 1, endReason: 'context_pressure' },
  { id: 's2', ordinal: 2, endReason: null },
];

describe('withSeams', () => {
  it('draws no seam for a single session — you did not rotate into the first one', () => {
    const items = withSeams([message('a', 's1', 0), message('b', 's1', 1)], SESSIONS);
    expect(items.map((i) => i.kind)).toEqual(['message', 'message']);
  });

  it('derives a seam exactly where adjacent messages change session', () => {
    const items = withSeams(
      [message('a', 's1', 0), message('b', 's2', 1), message('c', 's2', 2)],
      SESSIONS,
    );
    expect(items.map((i) => i.kind)).toEqual(['message', 'seam', 'message', 'message']);
  });

  it('labels the seam with the entered session and why the previous one ended', () => {
    const items = withSeams([message('a', 's1', 0), message('b', 's2', 1)], SESSIONS);
    expect(items[1]).toEqual({
      kind: 'seam',
      sessionId: 's2',
      ordinal: 2,
      endReason: 'context_pressure',
    });
  });

  it('handles an empty transcript', () => {
    expect(withSeams([], SESSIONS)).toEqual([]);
  });

  it('survives a session it has no metadata for rather than dropping the message', () => {
    const items = withSeams([message('a', 's1', 0), message('b', 'unknown', 1)], SESSIONS);
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ kind: 'seam', ordinal: 0 });
  });
});

describe('seamLabel', () => {
  it('explains why the PREVIOUS leg ended, which is the question a break in the page raises', () => {
    expect(seamLabel({ ordinal: 2, endReason: ESessionEndReason.context_pressure })).toBe(
      'session 2 · previous leg handed over',
    );
    expect(seamLabel({ ordinal: 3, endReason: ESessionEndReason.context_wall })).toBe(
      'session 3 · previous leg hit the context wall',
    );
  });

  it('still says something when the reason is unknown, rather than counting legs silently', () => {
    expect(seamLabel({ ordinal: 2, endReason: null })).toBe('session 2 · previous leg ended');
  });

  it('draws a leg it has no metadata for — an agent that rotated while the page was open', () => {
    expect(seamLabel({ ordinal: 0, endReason: null })).toBe('new session · previous leg ended');
  });
});

describe('currentSessionOrdinal', () => {
  it('reports the ordinal of the session that produced the last message', () => {
    expect(currentSessionOrdinal([message('a', 's2', 0)], SESSIONS)).toBe(2);
  });

  it('falls back to the newest session when there are no messages yet', () => {
    expect(currentSessionOrdinal([], SESSIONS)).toBe(2);
  });
});
