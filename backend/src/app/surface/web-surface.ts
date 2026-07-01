import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { ChatSurface, InboundChatMessage, PostOptions } from './chat-surface.port';
import { SYSTEM_SEED_AUTHOR, wrapSystemNotification } from './chat-surface.port';
import { APPROVE_ACTION_ID } from './approval-blocks';
import type { ApprovalDecision } from './approval-blocks';
import { webApprovalCard } from './web-approval-card';
import type { WebApprovalCard } from './web-approval-card';

/** A message Atlas POSTED — what SSE subscribers receive. */
export interface WebOutboundMessage {
  /** Synthetic ts (monotonic, seconds.fraction-shaped). */
  ts: string;
  channel: string;
  text: string;
  threadTs?: string;
  /** Web approval card payload (rendered when the post carries an approval card). */
  card?: WebApprovalCard;
  /**
   * Optional opaque metadata (from `PostOptions.meta`). The driver uses this to attach build-step
   * event context (e.g. `{ kind: 'build_event', stepId, sectionOrdinal, eventKind }`) so a web UI
   * can distinguish build-step engine events from conversational chat messages.
   */
  meta?: Record<string, unknown>;
  postedAt: Date;
}

/** Options for injecting a human message (programmatic / REST ingress). */
export interface WebInboundOptions {
  threadTs?: string;
  authorId?: string;
  authorName?: string;
  orgId?: string;
  /** System seed — deliver to the brain but don't persist as a chat bubble (see `InboundChatMessage.seed`). */
  seed?: boolean;
  /** Delivery seed — the `ask_question` card id whose answer this seed delivers (see `InboundChatMessage.seedQuestionId`). */
  seedQuestionId?: string;
}

const DEFAULT_TEAM_ID = 'a0a0a0a0-0000-4000-8000-000000000001'; // sentinel org uuid (web default tenant)
const DEFAULT_AUTHOR_ID = 'U-OPERATOR';
const DEFAULT_AUTHOR_NAME = 'Operator';

/**
 * R0 — the WEB `ChatSurface`. A server-sent events (SSE) + REST adapter that lets a web client have
 * a real conversation with Atlas with no Slack:
 *
 *  - INBOUND (toward Atlas): the web surface controller calls `receiveFromClient(channel, text, opts)`
 *    when it gets a `POST /web/say` request — this injects a human message onto `inbound$` exactly as
 *    if the operator typed it in the web app.
 *  - OUTBOUND (from Atlas): `post()` records the message, emits it on `outbound$` (the SSE feed), and
 *    returns a synthetic ts (the thread handle). The SSE controller subscribes and fans events to all
 *    connected clients in the channel.
 *  - APPROVAL CLICKS: the web surface controller calls `receiveApprovalClick(actionId, value, ruledBy)`
 *    which emits on `approval$` — the web surface module wires that to `DecisionApprovalService.resolve`
 *    via a dedicated control endpoint, keeping the surface decoupled from the brain.
 *
 * Transport: SSE for server→client (zero new deps; the controller writes chunked text/event-stream).
 * REST POST for client→server inbound messages and for approval clicks. The SSE endpoint is
 * `GET /web/events?channel=<channel>` (per-channel subscription); history is `GET /web/thread?channel=`.
 *
 * Threading is honored: `threadTs` in `receiveFromClient` is forwarded exactly as the Slack adapter
 * does it, so the chat bridge's `resolveThread` path is unchanged.
 *
 * The default orgId is `T-WEB` — enough to route messages through the chat bridge. Each REST call can
 * override it via `orgId` in the body when multi-tenant scenarios are needed.
 *
 * Zero v1 imports.
 */
@Injectable()
export class WebSurface implements ChatSurface {
  readonly name = 'web';
  private readonly logger = new Logger(WebSurface.name);

  private readonly inboundSubject = new Subject<InboundChatMessage>();
  private readonly outboundSubject = new Subject<WebOutboundMessage>();
  /** Control channel: approval-card button clicks arrive here (decoupled from the brain). */
  private readonly approvalSubject = new Subject<{
    actionId: string;
    value: string;
    ruledBy: string;
    note?: string;
  }>();
  /** Control channel: operator resume requests (POST /web/resume) — the driver subscribes via the port. */
  private readonly resumeSubject = new Subject<{ jobId: string }>();
  /** Thread metadata updates (e.g. an auto-generated title) — the SSE controller fans these to clients. */
  private readonly threadMetaSubject = new Subject<{ channel: string; jobId: string; title: string }>();

  /** Every message Atlas posted, in order — in-memory for the REST history endpoint. */
  readonly outbox: WebOutboundMessage[] = [];

  private seq = 0;
  private readonly defaultTeamId = DEFAULT_TEAM_ID;

  /** Inbound human messages — the chat bridge subscribes to this. */
  get inbound$(): Observable<InboundChatMessage> {
    return this.inboundSubject.asObservable();
  }

  /** Outbound Atlas messages — SSE controller fans these to connected clients. */
  get outbound$(): Observable<WebOutboundMessage> {
    return this.outboundSubject.asObservable();
  }

  /**
   * Approval-card button clicks — the web surface module subscribes and resolves the gate via
   * `DecisionApprovalService.resolve`. Decoupled: the surface never imports the brain.
   */
  get approval$(): Observable<{ actionId: string; value: string; ruledBy: string; note?: string }> {
    return this.approvalSubject.asObservable();
  }

  /** Operator resume requests — the driver (which injects this port) subscribes and re-drives the job. */
  get resumeRequests$(): Observable<{ jobId: string }> {
    return this.resumeSubject.asObservable();
  }

  /** Thread metadata updates (title) — the SSE controller maps these to `{ type: 'thread_meta' }` frames. */
  get threadMeta$(): Observable<{ channel: string; jobId: string; title: string }> {
    return this.threadMetaSubject.asObservable();
  }

  /** Broadcast a thread metadata change (the channel is the repo id the SSE stream is keyed by). */
  emitThreadMeta(channel: string, jobId: string, title: string): void {
    this.threadMetaSubject.next({ channel, jobId, title });
  }

  /** Emit a resume request (called by the controller on `POST /web/resume`). */
  requestResume(jobId: string): void {
    this.logger.debug(`requestResume job=${jobId}`);
    this.resumeSubject.next({ jobId });
  }

  // ── INBOUND ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Inject a human message onto `inbound$` from the web surface (called by the REST controller on
   * `POST /web/say`). Returns the synthetic ts of the injected message.
   */
  receiveFromClient(
    channel: string,
    text: string,
    opts: WebInboundOptions = {},
  ): string {
    const ts = this.mintTs();
    const message: InboundChatMessage = {
      id: ts,
      authorId: opts.authorId ?? DEFAULT_AUTHOR_ID,
      authorName: opts.authorName ?? DEFAULT_AUTHOR_NAME,
      text,
      orgId: opts.orgId ?? this.defaultTeamId,
      channel,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      ...(opts.seed ? { seed: true } : {}),
      ...(opts.seedQuestionId ? { seedQuestionId: opts.seedQuestionId } : {}),
      ts: new Date(),
    };
    this.logger.debug(
      `receiveFromClient → ${channel}${opts.threadTs ? ` (thread ${opts.threadTs})` : ''}: ${text.slice(0, 80)}`,
    );
    this.inboundSubject.next(message);
    return ts;
  }

  /**
   * Seed the thread's brain with a SYSTEM NOTIFICATION (see `ChatSurface.seedSystemNotification`). Wraps
   * `body` in `<system_notification>…</system_notification>` and injects it as a NON-persisted, System-
   * authored seed turn — the brain reacts to it, but it never renders as an operator chat bubble.
   */
  seedSystemNotification(
    channel: string,
    jobId: string,
    body: string,
    opts: { orgId?: string; deliveredQuestionId?: string } = {},
  ): string {
    return this.receiveFromClient(channel, wrapSystemNotification(body), {
      threadTs: jobId,
      seed: true,
      authorId: SYSTEM_SEED_AUTHOR.id,
      authorName: SYSTEM_SEED_AUTHOR.name,
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.deliveredQuestionId ? { seedQuestionId: opts.deliveredQuestionId } : {}),
    });
  }

  /**
   * Receive an approval-card button click from the web client (called by the REST controller on
   * `POST /web/approve`). Emits on `approval$` so the module bridge can resolve the gate without
   * the surface importing `DecisionApprovalService` (no circular dep).
   */
  receiveApprovalClick(actionId: string, value: string, ruledBy: string, note?: string): void {
    this.logger.debug(`receiveApprovalClick action=${actionId} ruledBy=${ruledBy}`);
    this.approvalSubject.next({ actionId, value, ruledBy, ...(note ? { note } : {}) });
  }

  // ── OUTBOUND (ChatSurface contract) ─────────────────────────────────────────────────────────────

  /**
   * Record and broadcast an Atlas post. Returns the synthetic ts.
   *
   * When `opts.blocks` contains a Block Kit approval card (detected by the APPROVE_ACTION_ID button),
   * the blocks are converted to a `WebApprovalCard` payload so the web client can render the card
   * with its action buttons — no Slack-specific shapes leak to the web layer.
   */
  async post(channel: string, text: string, opts: PostOptions = {}): Promise<string | undefined> {
    const ts = this.mintTs();

    let card: WebApprovalCard | undefined;
    if (opts.blocks?.length) {
      card = detectAndConvertApprovalCard(opts.blocks, text);
    }

    const message: WebOutboundMessage = {
      ts,
      channel,
      text,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      ...(card ? { card } : {}),
      ...(opts.meta ? { meta: opts.meta } : {}),
      postedAt: new Date(),
    };
    this.outbox.push(message);
    this.outboundSubject.next(message);
    return ts;
  }

  /**
   * Update a posted message in-place (edit the web card after a verdict). Mutates the outbox entry so
   * a history fetch reflects the verdict, and emits an outbound event with the same ts so live SSE
   * subscribers repaint.
   */
  update(
    channel: string,
    ts: string,
    args: { text?: string; card?: WebApprovalCard },
  ): void {
    const entry = this.outbox.find((m) => m.channel === channel && m.ts === ts);
    if (entry) {
      if (args.text !== undefined) entry.text = args.text;
      if (args.card !== undefined) entry.card = args.card;
      this.outboundSubject.next({ ...entry });
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────────────────────────

  /** Messages in a channel (all if no threadTs filter), ordered oldest-first. */
  channelMessages(channel: string, threadTs?: string): WebOutboundMessage[] {
    return this.outbox.filter(
      (m) =>
        m.channel === channel && (threadTs === undefined || m.threadTs === threadTs),
    );
  }

  /** Clear (between test scenarios). */
  reset(): void {
    this.outbox.length = 0;
  }

  private mintTs(): string {
    this.seq += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(this.seq).padStart(6, '0')}`;
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether a Block Kit `blocks` array is an approval card (contains an APPROVE_ACTION_ID
 * button) and if so extract the domain values and call `webApprovalCard()`. Returns undefined for any
 * other block array (plain text posts, non-approval cards).
 */
function detectAndConvertApprovalCard(
  blocks: Array<Record<string, unknown>>,
  text: string,
): WebApprovalCard | undefined {
  // Parse the meta from the approve button (same logic as `parseApprovalMeta`).
  let meta: { jobId: string; decisionRecordId?: string } | undefined;
  for (const block of blocks) {
    if (block.type !== 'actions') continue;
    const elements = block.elements as Array<Record<string, unknown>> | undefined;
    if (!elements) continue;
    for (const el of elements) {
      if (el.action_id !== APPROVE_ACTION_ID) continue;
      const raw = el.value;
      if (typeof raw !== 'string') continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed.jobId === 'string') {
          meta = {
            jobId: parsed.jobId,
            ...(typeof parsed.decisionRecordId === 'string'
              ? { decisionRecordId: parsed.decisionRecordId }
              : {}),
          };
        }
      } catch {
        // not our card
      }
    }
  }
  if (!meta) return undefined;

  // Extract summary (first track block text) and threads (numbered list in a later track block).
  let summary = '';
  const threads: string[] = [];
  let decisions: ApprovalDecision[] = [];
  let planUrl: string | undefined;
  // The headline is either "*Plan proposal — <title>*" (full ceremony) or "*Direct build — <title>*"
  // (fast path); the list block is labelled "*Tracks*" or "*Changes*" to match.
  let kind: 'plan' | 'direct' = 'plan';
  let title = text.replace(/^(?:Plan proposal|Direct build)\s*[—-]\s*/, '').trim() || text;

  for (const block of blocks) {
    if (block.type === 'track') {
      const t = block.text as Record<string, unknown> | undefined;
      const raw = typeof t?.text === 'string' ? (t.text as string) : '';
      if (raw.startsWith('*Plan proposal') || raw.startsWith('*Direct build')) {
        kind = raw.startsWith('*Direct build') ? 'direct' : 'plan';
        // Extract title from the headline block.
        const match = /(?:Plan proposal|Direct build)\s*[—-]\s*(.+)\*$/.exec(raw);
        if (match) title = match[1].trim();
      } else if (!summary) {
        summary = raw;
      } else if (raw.startsWith('*Tracks*') || raw.startsWith('*Changes*')) {
        // Parse the numbered track / change-outline list.
        const lines = raw.split('\n').slice(1); // drop the "*Tracks*"/"*Changes*" header line
        for (const line of lines) {
          const m = /^\d+\.\s+(.+)$/.exec(line.trim());
          if (m) threads.push(m[1]);
        }
      } else if (raw.startsWith('*Decisions*')) {
        // Parse decisions — bullet format: `• [confirmed|authored] *title* _(class)_ — ruling`. The
        // provenance tag is an optional leading group so the greedy ruling capture is unaffected.
        const lines = raw.split('\n').slice(1);
        for (const line of lines) {
          const m = /^•\s+(?:\[(confirmed|authored)\]\s+)?\*(.+?)\*\s+_\((.+?)\)_\s+[—-]\s+(.+)$/.exec(
            line.trim(),
          );
          if (m) {
            decisions.push({
              title: m[2],
              decisionClass: m[3],
              ruling: m[4],
              confirmedByOperator: m[1] === 'confirmed',
            });
          }
        }
      }
    }
    if (block.type === 'actions') {
      const elements = block.elements as Array<Record<string, unknown>> | undefined;
      for (const el of elements ?? []) {
        if (typeof el.url === 'string') planUrl = el.url;
      }
    }
  }

  return webApprovalCard({
    jobId: meta.jobId,
    ...(meta.decisionRecordId ? { decisionRecordId: meta.decisionRecordId } : {}),
    kind,
    title,
    summary,
    ...(decisions.length ? { decisions } : {}),
    threads,
    ...(planUrl ? { planUrl } : {}),
  });
}
