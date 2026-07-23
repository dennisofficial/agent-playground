import type { JobMessage } from '@/lib/api/job-api';
import { EThreadOutputType } from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import { messageOrderMs } from '../components/conversation/conversation';

function fixture(overrides: Partial<JobMessage>): JobMessage {
  return {
    ts: '1',
    threadId: 'thread-1',
    subagentId: null,
    text: 'text',
    type: EThreadOutputType.CHAT,
    source: 'atlas',
    postedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('messageOrderMs', () => {
  it('uses orderAt when present, over deliveredAt and postedAt', () => {
    const m = fixture({
      postedAt: '2026-07-17T11:00:05.000Z',
      orderAt: '2026-07-17T11:00:31.000Z',
    });
    expect(messageOrderMs(m)).toBe(Date.parse('2026-07-17T11:00:31.000Z'));
  });

  it('falls back to deliveredAt when orderAt is absent', () => {
    const m = fixture({
      postedAt: '2026-07-17T10:00:00.000Z',
      deliveredAt: '2026-07-17T10:00:35.000Z',
    });
    expect(messageOrderMs(m)).toBe(Date.parse('2026-07-17T10:00:35.000Z'));
  });

  it('falls back to postedAt when both orderAt and deliveredAt are absent', () => {
    const m = fixture({ postedAt: '2026-07-17T10:00:30.000Z' });
    expect(messageOrderMs(m)).toBe(Date.parse('2026-07-17T10:00:30.000Z'));
  });

  it("reproduces the reported bug's fixed order: an in-flight reply sorts before a pill delivered later", () => {
    const reply = fixture({
      ts: 'reply',
      postedAt: '2026-07-17T10:00:30.000Z',
    });
    const pill = fixture({
      ts: 'pill',
      postedAt: '2026-07-17T10:00:00.000Z',
      deliveredAt: '2026-07-17T10:00:35.000Z',
    });
    expect(messageOrderMs(reply)).toBeLessThan(messageOrderMs(pill));
  });
});
