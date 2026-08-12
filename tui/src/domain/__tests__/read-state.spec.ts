import { describe, expect, it } from 'bun:test';
import { firstUnseenIndex, hasUnseen, isPinnedToBottom } from '../read-state.js';

const at = (iso: string): Date => new Date(iso);

describe('hasUnseen', () => {
  it('calls a thread you have never opened unseen', () => {
    expect(hasUnseen({ lastMessageAt: at('2026-08-11T10:00:00Z'), lastSeenAt: null })).toBe(true);
  });

  it('calls a thread nobody has spoken in seen — there is nothing to have missed', () => {
    expect(hasUnseen({ lastMessageAt: null, lastSeenAt: null })).toBe(false);
  });

  it('compares the newest message against the last time you reached the bottom', () => {
    expect(
      hasUnseen({ lastMessageAt: at('2026-08-11T10:00:00Z'), lastSeenAt: at('2026-08-11T09:00:00Z') }),
    ).toBe(true);
    expect(
      hasUnseen({ lastMessageAt: at('2026-08-11T09:00:00Z'), lastSeenAt: at('2026-08-11T10:00:00Z') }),
    ).toBe(false);
  });

  it('does not call the message you were looking at unseen', () => {
    const same = at('2026-08-11T10:00:00Z');

    expect(hasUnseen({ lastMessageAt: same, lastSeenAt: same })).toBe(false);
  });
});

describe('firstUnseenIndex', () => {
  const messages = [
    { createdAt: at('2026-08-11T09:00:00Z') },
    { createdAt: at('2026-08-11T09:30:00Z') },
    { createdAt: at('2026-08-11T10:00:00Z') },
  ];

  it('lands on the oldest message you have not seen', () => {
    expect(firstUnseenIndex({ messages, lastSeenAt: at('2026-08-11T09:15:00Z') })).toBe(1);
  });

  it('returns -1 when you have seen the lot', () => {
    expect(firstUnseenIndex({ messages, lastSeenAt: at('2026-08-11T11:00:00Z') })).toBe(-1);
  });

  it('returns 0 for a thread never opened — the caller draws no rule above the first message', () => {
    expect(firstUnseenIndex({ messages, lastSeenAt: null })).toBe(0);
  });

  it('returns -1 for an empty transcript', () => {
    expect(firstUnseenIndex({ messages: [], lastSeenAt: null })).toBe(-1);
  });
});

describe('isPinnedToBottom', () => {
  it('is pinned when the content is shorter than the viewport — that IS the bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 4, viewportHeight: 20 })).toBe(true);
  });

  it('is not pinned partway up a long transcript', () => {
    expect(isPinnedToBottom({ scrollTop: 10, scrollHeight: 200, viewportHeight: 20 })).toBe(false);
  });

  it('is pinned at the last scrollable row', () => {
    expect(isPinnedToBottom({ scrollTop: 180, scrollHeight: 200, viewportHeight: 20 })).toBe(true);
  });
});
