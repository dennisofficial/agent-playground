import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { describe, expect, it } from 'vitest';
import { decisionApprovalBlocks } from '../surface';
import {
  AgentChatSurface,
  parseApprovalMeta,
} from './agent-chat-surface';

describe('AgentChatSurface — the in-process programmatic ChatSurface (W6)', () => {
  it('sendFromHuman emits on inbound$ with the right channel + default author', async () => {
    const surface = new AgentChatSurface();
    const next = firstValueFrom(surface.inbound$.pipe(take(1)));

    const ts = surface.sendFromHuman('C-PROJ', 'build me CSV export');

    const msg = await next;
    expect(msg.id).toBe(ts);
    expect(msg.channel).toBe('C-PROJ');
    expect(msg.text).toBe('build me CSV export');
    expect(msg.authorId).toBe('U-DENNIS');
    expect(msg.authorName).toBe('Dennis');
    expect(msg.threadTs).toBeUndefined(); // a fresh top-level message
  });

  it('sendFromHuman carries threadTs when replying into a thread', async () => {
    const surface = new AgentChatSurface();
    const next = firstValueFrom(surface.inbound$.pipe(take(1)));

    surface.sendFromHuman('C1', 'yes, use Postgres', { threadTs: 'root.001', authorId: 'U9' });

    const msg = await next;
    expect(msg.threadTs).toBe('root.001');
    expect(msg.authorId).toBe('U9');
  });

  it('post records into the outbox, emits on outbound$, and returns a synthetic ts', async () => {
    const surface = new AgentChatSurface();
    const next = firstValueFrom(surface.outbound$.pipe(take(1)));

    const ts = await surface.post('C1', 'on it', { threadTs: 'root.1' });

    expect(ts).toBeTypeOf('string');
    const emitted = await next;
    expect(emitted.ts).toBe(ts);
    expect(emitted.text).toBe('on it');
    expect(emitted.threadTs).toBe('root.1');
    expect(surface.outbox).toHaveLength(1);
    expect(surface.outbox[0].text).toBe('on it');
  });

  it('waitForReply resolves on the next matching outbound post', async () => {
    const surface = new AgentChatSurface();
    const wait = surface.waitForReply((m) => m.text.includes('PR ready'), 1000);

    await surface.post('C1', 'planning…', { threadTs: 'r.1' });
    await surface.post('C1', ':tada: PR ready: https://github.com/x/y/pull/1', { threadTs: 'r.1' });

    const reply = await wait;
    expect(reply.text).toContain('PR ready');
  });

  it('waitForReply rejects on timeout when nothing matches', async () => {
    const surface = new AgentChatSurface();
    await expect(
      surface.waitForReply((m) => m.text === 'never', 20),
    ).rejects.toBeDefined();
  });

  it('threaded round-trip: human → reply in thread → human reply continues the SAME thread', async () => {
    const surface = new AgentChatSurface();
    const inbound = firstValueFrom(surface.inbound$.pipe(take(2), toArray()));

    // 1. Human opens a top-level conversation; its inbound id is the thread root.
    const rootTs = surface.sendFromHuman('C1', 'add export');

    // 2. Atlas replies IN-THREAD off that root (the brain resolves threadTs == rootTs).
    await surface.post('C1', 'a few questions first…', { threadTs: rootTs });

    // 3. Human answers in the SAME thread — passing rootTs continues the conversation.
    surface.sendFromHuman('C1', 'csv, gated by feature flag', { threadTs: rootTs });

    const msgs = await inbound;
    expect(msgs[0].id).toBe(rootTs);
    expect(msgs[0].threadTs).toBeUndefined();
    expect(msgs[1].threadTs).toBe(rootTs); // the follow-up continues the thread
    // Atlas's reply was threaded under the same root.
    expect(surface.threadMessages(rootTs)).toHaveLength(1);
    expect(surface.threadMessages(rootTs)[0].text).toContain('questions');
  });

  describe('approval simulation', () => {
    it('captures a posted approval card with its parsed jobId (the resolve seam)', async () => {
      const surface = new AgentChatSurface();
      const blocks = decisionApprovalBlocks({
        jobId: 'job-42',
        decisionRecordId: 'dr-7',
        title: 'CSV export',
        summary: 'Add CSV export to the reports page.',
        threads: ['Backend', 'Frontend'],
      });

      await surface.post('C1', 'Plan proposal — CSV export', { threadTs: 'root.1', blocks });

      const card = surface.latestApprovalCard();
      expect(card).toBeDefined();
      expect(card!.jobId).toBe('job-42');
      expect(card!.decisionRecordId).toBe('dr-7');
      expect(card!.message.threadTs).toBe('root.1');
    });

    it('waitForApprovalCard blocks until the card is posted', async () => {
      const surface = new AgentChatSurface();
      const wait = surface.waitForApprovalCard(1000);

      await surface.post('C1', 'still grilling…', { threadTs: 'root.1' });
      await surface.post('C1', 'Plan proposal', {
        threadTs: 'root.1',
        blocks: decisionApprovalBlocks({
          jobId: 'job-99',
          title: 'X',
          summary: 'Y',
          threads: ['Z'],
        }),
      });

      const card = await wait;
      expect(card.jobId).toBe('job-99');
    });

    it('approvalCards() ignores ordinary posts (no approve button)', async () => {
      const surface = new AgentChatSurface();
      await surface.post('C1', 'just a status update', { threadTs: 'root.1' });
      expect(surface.approvalCards()).toHaveLength(0);
      expect(surface.latestApprovalCard()).toBeUndefined();
    });
  });

  describe('parseApprovalMeta', () => {
    it('returns the meta from a real approval card', () => {
      const blocks = decisionApprovalBlocks({
        jobId: 'j1',
        decisionRecordId: 'd1',
        title: 'T',
        summary: 'S',
        threads: [],
      });
      expect(parseApprovalMeta(blocks)).toEqual({ jobId: 'j1', decisionRecordId: 'd1' });
    });

    it('returns undefined for missing/non-approval blocks', () => {
      expect(parseApprovalMeta(undefined)).toBeUndefined();
      expect(parseApprovalMeta([{ type: 'thread', text: { type: 'mrkdwn', text: 'x' } }])).toBeUndefined();
    });
  });
});
