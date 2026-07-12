/**
 * R0 GATE — WebSurface unit tests.
 *
 * Proves:
 *  1. A web/agent client posts a message that surfaces on `inbound$`.
 *  2. An outbound `post()` (incl. a threaded reply) is captured and emitted on `outbound$`.
 *  3. An approval card (Block Kit blocks) passed to `post()` is converted to a `WebApprovalCard`
 *     payload that the web client can render.
 *  4. A simulated approve/deny click via `receiveApprovalClick` resolves the pending verdict through
 *     the `approval$` Subject (the module bridge calls `DecisionApprovalService.resolve`).
 *  5. The `update()` method mutates the outbox entry and re-emits a patched event.
 *  6. The web-approval-card builder (pure) renders the correct action ids and value.
 *  7. `parseWebApprovalMeta` round-trips the ids from a card's action value.
 *
 * No I/O, no Postgres, no LLM — pure in-process unit tests.
 */

import { firstValueFrom } from 'rxjs';
import { take, toArray, filter } from 'rxjs/operators';
import { describe, it, expect, beforeEach } from 'vitest';
import { WebSurface } from './web-surface';
import { agentMessage } from '../prompt-kit/message';
import {
  decisionApprovalBlocks,
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  SHIP_ACTION_ID,
} from './approval-blocks';
import type { DecisionApprovalCard } from './approval-blocks';
import { webApprovalCard, webShipReviewCard, webVerdictCard, parseWebApprovalMeta } from './web-approval-card';

// ── Fixtures ──────────────────────────────────��──────────────────────────���──────────────────────

const SAMPLE_CARD: DecisionApprovalCard = {
  jobId: 'job-abc',
  decisionRecordId: 'dr-xyz',
  title: 'Payments integration',
  summary: 'Use Stripe; add a webhooks table.',
  threads: ['Backend: Stripe client + webhooks', 'Frontend: checkout page'],
  decisions: [
    { decisionClass: 'dependency', title: 'Payment gateway', ruling: 'Stripe' },
  ],
};

// ── 1 + 2: inbound$ and outbound$ ────────────────────────────────────────────────────────────���─

describe('WebSurface — inbound + outbound', () => {
  let surface: WebSurface;

  beforeEach(() => {
    surface = new WebSurface();
  });

  it('receiveFromClient emits on inbound$ with all fields', async () => {
    const received = firstValueFrom(surface.inbound$.pipe(take(1)));

    const ts = surface.receiveFromClient('C-web', 'Hello Atlas', {
      authorId: 'U-op',
      authorName: 'Operator',
      orgId: 'T-acme',
      threadTs: 'root-ts',
    });

    const msg = await received;
    expect(msg.id).toBe(ts);
    expect(msg.channel).toBe('C-web');
    expect(msg.text).toBe('Hello Atlas');
    expect(msg.authorId).toBe('U-op');
    expect(msg.authorName).toBe('Operator');
    expect(msg.orgId).toBe('T-acme');
    expect(msg.threadTs).toBe('root-ts');
  });

  it('receiveFromClient defaults orgId/author when not supplied', async () => {
    const received = firstValueFrom(surface.inbound$.pipe(take(1)));
    surface.receiveFromClient('C-web', 'Hi');
    const msg = await received;
    expect(msg.orgId).toBe('a0a0a0a0-0000-4000-8000-000000000001'); // web default-tenant sentinel uuid
    expect(msg.authorId).toBe('U-OPERATOR');
    expect(msg.threadTs).toBeUndefined();
  });

  it('seedSystemNotification emits a System-authored, <system_notice>-wrapped, non-persisted seed', async () => {
    const received = firstValueFrom(surface.inbound$.pipe(take(1)));
    const ts = surface.seedSystemNotification('C-web', 'thread-9', agentMessage('Build failed on step 3'), {
      orgId: 'T-acme',
    });
    const msg = await received;
    expect(msg.id).toBe(ts);
    expect(msg.threadTs).toBe('thread-9'); // lands in the thread
    expect(msg.seed).toBe(true); // NOT persisted as a chat bubble (intake skips recordChatStimulus)
    expect(msg.authorId).toBe('U-SYSTEM'); // System, not the operator (no awareness drain)
    expect(msg.text).toBe('<system_notice>Build failed on step 3</system_notice>');
    expect(msg.orgId).toBe('T-acme');
  });

  it('post() emits on outbound$ and is captured in the outbox', async () => {
    const outbound = firstValueFrom(surface.outbound$.pipe(take(1)));

    const ts = await surface.post('C-web', 'Plan approved!');
    expect(ts).toBeDefined();

    const msg = await outbound;
    expect(msg.ts).toBe(ts);
    expect(msg.channel).toBe('C-web');
    expect(msg.text).toBe('Plan approved!');
    expect(msg.card).toBeUndefined();

    expect(surface.outbox).toHaveLength(1);
    expect(surface.outbox[0].ts).toBe(ts);
  });

  it('post() carries threadTs for thread replies', async () => {
    const rootTs = await surface.post('C-web', 'Root message');
    const replyTs = await surface.post('C-web', 'Reply', { threadTs: rootTs });

    expect(surface.outbox[0].threadTs).toBeUndefined();
    expect(surface.outbox[1].threadTs).toBe(rootTs);
    expect(replyTs).not.toBe(rootTs);
  });

  it('post() emits multiple messages in order', async () => {
    const collected = firstValueFrom(surface.outbound$.pipe(take(3), toArray()));

    await surface.post('C-web', 'First');
    await surface.post('C-web', 'Second');
    await surface.post('C-web', 'Third');

    const msgs = await collected;
    expect(msgs.map((m) => m.text)).toEqual(['First', 'Second', 'Third']);
  });
});

// ── 3: Approval card conversion ────────────────────────────────────────────────────────────────

describe('WebSurface — approval card conversion', () => {
  let surface: WebSurface;

  beforeEach(() => {
    surface = new WebSurface();
  });

  it('post() with Block Kit approval blocks converts to a WebApprovalCard', async () => {
    const blocks = decisionApprovalBlocks(SAMPLE_CARD);
    const outbound = firstValueFrom(surface.outbound$.pipe(take(1)));

    const ts = await surface.post('C-web', `Plan proposal — ${SAMPLE_CARD.title}`, { blocks });
    expect(ts).toBeDefined();

    const msg = await outbound;
    expect(msg.card).toBeDefined();
    const card = msg.card!;

    expect(card.type).toBe('approval_card');
    expect(card.jobId).toBe('job-abc');
    expect(card.decisionRecordId).toBe('dr-xyz');
    expect(card.title).toBe('Payments integration');
    expect(card.summary).toContain('Use Stripe');
    expect(card.threads).toHaveLength(2);
    expect(card.threads[0]).toContain('Backend');
    expect(card.threads[1]).toContain('Frontend');

    // Approve and Deny are emitted; there is no request-changes button (operators request
    // changes by just messaging the brain).
    const actionIds = card.actions.map((a) => a.actionId);
    expect(actionIds).toContain(APPROVE_ACTION_ID);
    expect(actionIds).toContain(DENY_ACTION_ID);
    expect(actionIds).not.toContain(REQUEST_CHANGES_ACTION_ID);

    // The value round-trips through JSON correctly.
    const approveAction = card.actions.find((a) => a.actionId === APPROVE_ACTION_ID)!;
    expect(approveAction.style).toBe('primary');
    const meta = parseWebApprovalMeta(approveAction.value);
    expect(meta?.jobId).toBe('job-abc');
    expect(meta?.decisionRecordId).toBe('dr-xyz');
  });

  it('decision provenance (confirmedByOperator) survives the Block Kit → WebApprovalCard reparse', async () => {
    const card: DecisionApprovalCard = {
      ...SAMPLE_CARD,
      decisions: [
        { decisionClass: 'dependency', title: 'Payment gateway', ruling: 'Stripe', confirmedByOperator: true },
        { decisionClass: 'api_contract', title: 'Webhook route', ruling: 'POST /webhooks', confirmedByOperator: false },
      ],
    };
    const blocks = decisionApprovalBlocks(card);
    const outbound = firstValueFrom(surface.outbound$.pipe(take(1)));
    await surface.post('C-web', `Plan proposal — ${card.title}`, { blocks });
    const decisions = (await outbound).card!.decisions;

    expect(decisions).toHaveLength(2);
    const confirmed = decisions.find((d) => d.title === 'Payment gateway');
    const authored = decisions.find((d) => d.title === 'Webhook route');
    expect(confirmed?.confirmedByOperator).toBe(true);
    expect(authored?.confirmedByOperator).toBe(false);
    // The ruling capture is unaffected by the leading provenance tag.
    expect(confirmed?.ruling).toBe('Stripe');
    expect(authored?.ruling).toBe('POST /webhooks');
  });

  it('post() with non-approval blocks does NOT produce a card', async () => {
    const blocks = [{ type: 'thread', text: { type: 'mrkdwn', text: 'Hello' } }];
    await surface.post('C-web', 'Hello', { blocks });
    expect(surface.outbox[0].card).toBeUndefined();
  });

  it('post() without blocks produces no card', async () => {
    await surface.post('C-web', 'Plain text');
    expect(surface.outbox[0].card).toBeUndefined();
  });
});

// ── 4: Approval click + approval$ Subject ─────────────────────────────────────────────────────

describe('WebSurface — approval click via approval$', () => {
  it('receiveApprovalClick emits on approval$ with all fields', async () => {
    const surface = new WebSurface();
    const click = firstValueFrom(surface.approval$.pipe(take(1)));

    const value = JSON.stringify({ jobId: 'job-abc', decisionRecordId: 'dr-xyz' });
    surface.receiveApprovalClick(APPROVE_ACTION_ID, value, 'U-dennis');

    const event = await click;
    expect(event.actionId).toBe(APPROVE_ACTION_ID);
    expect(event.value).toBe(value);
    expect(event.ruledBy).toBe('U-dennis');
  });

  it('receiveApprovalClick emits deny action', async () => {
    const surface = new WebSurface();
    const click = firstValueFrom(surface.approval$.pipe(take(1)));

    const value = JSON.stringify({ jobId: 'job-abc' });
    surface.receiveApprovalClick(DENY_ACTION_ID, value, 'U-dennis');

    const event = await click;
    expect(event.actionId).toBe(DENY_ACTION_ID);
  });

  it('forwards the operator note on approval$ (BACKEND_GAPS #5)', async () => {
    const surface = new WebSurface();
    const click = firstValueFrom(surface.approval$.pipe(take(1)));

    const value = JSON.stringify({ jobId: 'job-abc' });
    surface.receiveApprovalClick(DENY_ACTION_ID, value, 'U-dennis', 'use Stripe, not Braintree');

    const event = await click;
    expect(event.note).toBe('use Stripe, not Braintree');
  });

  it('omits note when none is supplied', async () => {
    const surface = new WebSurface();
    const click = firstValueFrom(surface.approval$.pipe(take(1)));

    surface.receiveApprovalClick(APPROVE_ACTION_ID, JSON.stringify({ jobId: 'job-abc' }), 'U-dennis');

    const event = await click;
    expect(event.note).toBeUndefined();
  });

  it('requestResume emits the jobId on resumeRequests$ (BACKEND_GAPS #9)', async () => {
    const surface = new WebSurface();
    const req = firstValueFrom(surface.resumeRequests$.pipe(take(1)));

    surface.requestResume('job-xyz');

    expect(await req).toEqual({ jobId: 'job-xyz' });
  });
});

// ── 5: update() ───────────────────────────────────────────────────────────────────────────────

describe('WebSurface — update()', () => {
  it('mutates the outbox entry and re-emits the updated message', async () => {
    const surface = new WebSurface();

    // Post the original approval card.
    const blocks = decisionApprovalBlocks(SAMPLE_CARD);
    const ts = await surface.post('C-web', `Plan proposal — ${SAMPLE_CARD.title}`, { blocks });
    expect(ts).toBeDefined();

    // Subscribe BEFORE calling update.
    const updated = firstValueFrom(
      surface.outbound$.pipe(
        filter((m) => m.ts === ts),
        take(1),
      ),
    );

    // Simulate a verdict: update with a verdict card.
    const verdict = webVerdictCard('job-abc', 'Payments integration', 'approve', 'Approved by Dennis');
    surface.update('C-web', ts!, { text: 'Approved by Dennis', card: verdict as any });

    const msg = await updated;
    expect(msg.ts).toBe(ts);
    expect(msg.text).toBe('Approved by Dennis');
    // The card was replaced.
    expect(msg.card).toBeDefined();
    expect((msg.card as any).type).toBe('verdict_card');

    // Outbox also reflects the mutation.
    const outboxEntry = surface.outbox.find((m) => m.ts === ts)!;
    expect(outboxEntry.text).toBe('Approved by Dennis');
  });

  it('update on a non-existent ts is a silent no-op', () => {
    const surface = new WebSurface();
    expect(() => surface.update('C-web', 'ts-ghost', { text: 'noop' })).not.toThrow();
  });
});

// ── 6: webApprovalCard builder (pure) ──────────────────────────────────────────────────────────

describe('webApprovalCard (pure builder)', () => {
  it('produces a WebApprovalCard with all domain fields', () => {
    const result = webApprovalCard(SAMPLE_CARD);

    expect(result.type).toBe('approval_card');
    expect(result.jobId).toBe('job-abc');
    expect(result.decisionRecordId).toBe('dr-xyz');
    expect(result.title).toBe('Payments integration');
    expect(result.summary).toBe('Use Stripe; add a webhooks table.');
    expect(result.threads).toEqual([
      'Backend: Stripe client + webhooks',
      'Frontend: checkout page',
    ]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].title).toBe('Payment gateway');
    expect(result.decisions[0].ruling).toBe('Stripe');
  });

  it('includes a View plan link button only when planUrl is given', () => {
    const without = webApprovalCard(SAMPLE_CARD);
    const withUrl = webApprovalCard({ ...SAMPLE_CARD, planUrl: 'https://x/plan' });

    expect(without.planUrl).toBeUndefined();
    expect(without.actions.some((a) => a.url)).toBe(false);

    expect(withUrl.planUrl).toBe('https://x/plan');
    const linkBtn = withUrl.actions.find((a) => a.url === 'https://x/plan');
    expect(linkBtn).toBeDefined();
  });

  it('verdicts have the correct styles', () => {
    const card = webApprovalCard(SAMPLE_CARD);
    const styles: Record<string, string> = {};
    for (const action of card.actions) styles[action.actionId] = action.style;
    expect(styles[APPROVE_ACTION_ID]).toBe('primary');
    expect(styles[DENY_ACTION_ID]).toBe('danger');
    expect(styles[REQUEST_CHANGES_ACTION_ID]).toBeUndefined();
  });

  it('ship-review cards expose both ship and retract actions', () => {
    const card = webShipReviewCard({
      jobId: 'job-ship',
      title: 'Ready to ship',
      summary: 'Reviewed.',
    });

    const actions = new Map(card.actions.map((a) => [a.actionId, a]));
    expect(actions.get(SHIP_ACTION_ID)).toMatchObject({
      label: 'Ship it',
      style: 'primary',
    });
    expect(actions.get(RETRACT_SHIP_ACTION_ID)).toMatchObject({
      label: 'Amend build',
      style: 'default',
    });
    expect(parseWebApprovalMeta(actions.get(RETRACT_SHIP_ACTION_ID)!.value)).toEqual({
      jobId: 'job-ship',
    });
  });
});

// ── 7: parseWebApprovalMeta ────────────────────────────────────────────────────────────────────

describe('parseWebApprovalMeta', () => {
  it('round-trips jobId + decisionRecordId', () => {
    const value = JSON.stringify({ jobId: 'job-1', decisionRecordId: 'dr-2' });
    const meta = parseWebApprovalMeta(value);
    expect(meta?.jobId).toBe('job-1');
    expect(meta?.decisionRecordId).toBe('dr-2');
  });

  it('round-trips jobId-only (no decisionRecordId)', () => {
    const value = JSON.stringify({ jobId: 'job-1' });
    const meta = parseWebApprovalMeta(value);
    expect(meta?.jobId).toBe('job-1');
    expect(meta?.decisionRecordId).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseWebApprovalMeta('not-json')).toBeUndefined();
  });

  it('returns undefined when jobId is missing', () => {
    expect(parseWebApprovalMeta(JSON.stringify({ other: 'field' }))).toBeUndefined();
  });
});

// ── channelMessages utility ────────────────────────────────────────────────────────────────────

describe('WebSurface.channelMessages', () => {
  it('returns all messages in a channel when no threadTs filter', async () => {
    const surface = new WebSurface();
    await surface.post('C-1', 'a');
    await surface.post('C-1', 'b', { threadTs: 'root' });
    await surface.post('C-2', 'c');

    const c1 = surface.channelMessages('C-1');
    expect(c1).toHaveLength(2);

    const c2 = surface.channelMessages('C-2');
    expect(c2).toHaveLength(1);
  });

  it('filters by threadTs when given', async () => {
    const surface = new WebSurface();
    await surface.post('C-1', 'top-level');
    await surface.post('C-1', 'in-thread', { threadTs: 'root-1' });
    await surface.post('C-1', 'in-thread-2', { threadTs: 'root-1' });

    const threaded = surface.channelMessages('C-1', 'root-1');
    expect(threaded).toHaveLength(2);
    expect(threaded[0].text).toBe('in-thread');
  });
});
