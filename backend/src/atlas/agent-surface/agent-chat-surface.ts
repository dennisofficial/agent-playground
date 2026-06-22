import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom, Observable, Subject, timeout } from 'rxjs';
import { filter, first } from 'rxjs/operators';
import type {
  ChatSurface,
  InboundChatMessage,
  PostOptions,
} from '../surface/chat-surface.port';
import { APPROVE_ACTION_ID, type ApprovalActionMeta } from '../surface/approval-blocks';

/** A message Atlas POSTED, captured for inspection by a programmatic driver. */
export interface OutboundChatMessage {
  /** The synthetic ts the surface minted for this post (the thread handle for replies into it). */
  ts: string;
  channel: string;
  text: string;
  /** Set when the post was a thread reply (the thread root ts). */
  threadTs?: string;
  /** Block Kit blocks, when the post carried them (e.g. an approval card). */
  blocks?: Array<Record<string, unknown>>;
  postedAt: Date;
}

/** Options for `sendFromHuman` — the simulated operator + thread the message lands in. */
export interface SendOptions {
  /** Reply into this thread (the thread root ts). Omit to open a new top-level conversation. */
  threadTs?: string;
  /** The simulated author id (default 'U-DENNIS'). */
  authorId?: string;
  /** The simulated author display name (default 'Dennis'). */
  authorName?: string;
  /** The tenant id the message belongs to (default the surface's configured `teamId`). */
  teamId?: string;
}

/** A captured approval card + the ids needed to resolve it (parsed from the card's button value). */
export interface CapturedApprovalCard {
  /** The outbound post that carried the card. */
  message: OutboundChatMessage;
  /** The job this approval gates (the seam W9 passes to `DecisionApprovalService.resolve`). */
  jobId: string;
  decisionRecordId?: string;
}

const DEFAULT_TEAM_ID = 'T-AGENT';
const DEFAULT_AUTHOR_ID = 'U-DENNIS';
const DEFAULT_AUTHOR_NAME = 'Dennis';

/**
 * W6 — THE AGENT-FACING `ChatSurface`. An in-process implementation of the thread-aware surface that
 * lets a PROGRAM (me / a build sub-agent / a test) DRIVE Atlas end-to-end with no Slack — the seam W9
 * boots to script a brain → driver → PR feature drive.
 *
 * It is symmetrical to the web surface (`AtlasWebSurface`):
 *  - INBOUND (toward Atlas): `sendFromHuman(channel, text, { threadTs })` injects a human message onto
 *    `inbound$` exactly as if Dennis typed it — the chat bridge maps it to a `ChatStimulus`. Threading
 *    is honored: pass the root ts (the first post's ts) as `threadTs` to continue a job's thread.
 *  - OUTBOUND (from Atlas): `post()` records the message into an inspectable, awaitable log and emits it
 *    on `outbound$`, returning a synthetic ts (the thread handle). `waitForReply(predicate)` lets a
 *    caller block until Atlas says something matching — so a script can grill → answer → approve.
 *
 * Approval simulation: Atlas posts the decision-record approval card through `post()` (with Block Kit
 * blocks). `approvalCards()` / `latestApprovalCard()` surface those, parsing the `jobId` out of the
 * card's button value — the caller then resolves the gate via `DecisionApprovalService.resolve(jobId,
 * 'approve', …)` (the surface stays decoupled from the brain; it only READS the card).
 *
 * No `connect()` — there's no transport to open; the chat bridge's connect step is a safe no-op for
 * this surface. Zero v1 imports.
 */
@Injectable()
export class AgentChatSurface implements ChatSurface {
  readonly name = 'agent';
  private readonly logger = new Logger(AgentChatSurface.name);

  private readonly inboundSubject = new Subject<InboundChatMessage>();
  private readonly outboundSubject = new Subject<OutboundChatMessage>();

  /** Every message Atlas posted, in order — the inspectable outbox. */
  readonly outbox: OutboundChatMessage[] = [];

  private seq = 0;
  /** The default tenant id stamped on injected human messages (overridable per `sendFromHuman`). */
  private readonly teamId = DEFAULT_TEAM_ID;

  /** Inbound human messages — what the chat bridge subscribes to (same contract as the Slack adapter). */
  get inbound$(): Observable<InboundChatMessage> {
    return this.inboundSubject.asObservable();
  }

  /** Outbound Atlas messages — a programmatic driver reads Atlas's replies here. */
  get outbound$(): Observable<OutboundChatMessage> {
    return this.outboundSubject.asObservable();
  }

  // ── INBOUND: drive Atlas as the human ──────────────────────────────────────────────────────────

  /**
   * Inject a human message onto `inbound$` — as if Dennis typed it. Returns the synthetic ts of the
   * injected message (the handle a NEW top-level message uses to seed its own thread, mirroring Slack
   * where a root message's ts is its thread ref). A reply (`threadTs` set) continues that thread.
   */
  sendFromHuman(channel: string, text: string, opts: SendOptions = {}): string {
    const ts = this.mintTs();
    const message: InboundChatMessage = {
      id: ts,
      authorId: opts.authorId ?? DEFAULT_AUTHOR_ID,
      authorName: opts.authorName ?? DEFAULT_AUTHOR_NAME,
      text,
      teamId: opts.teamId ?? this.teamId,
      channel,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      ts: new Date(),
    };
    this.logger.debug(`sendFromHuman → ${channel}${opts.threadTs ? ` (thread ${opts.threadTs})` : ''}: ${text.slice(0, 80)}`);
    this.inboundSubject.next(message);
    return ts;
  }

  // ── OUTBOUND: capture Atlas's posts (the ChatSurface contract) ──────────────────────────────────

  /** Record an Atlas post into the outbox, emit on `outbound$`, return the synthetic ts. */
  async post(channel: string, text: string, opts: PostOptions = {}): Promise<string | undefined> {
    const ts = this.mintTs();
    const message: OutboundChatMessage = {
      ts,
      channel,
      text,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
      postedAt: new Date(),
    };
    this.outbox.push(message);
    this.outboundSubject.next(message);
    return ts;
  }

  // ── DRIVER READ API: read Atlas's replies, continue the conversation ────────────────────────────

  /**
   * Resolve with the next Atlas post matching `predicate` (e.g. "the reply names a PR url"). Rejects
   * on timeout. ONLY matches FUTURE posts — call this BEFORE the `sendFromHuman` that should trigger
   * the reply (the standard request/await ordering), so a fast reply can't race ahead of the wait.
   */
  waitForReply(
    predicate: (m: OutboundChatMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<OutboundChatMessage> {
    return firstValueFrom(
      this.outbound$.pipe(filter(predicate), first(), timeout({ each: timeoutMs })),
    );
  }

  /** Outbox messages posted into a specific thread (the job's conversation), in order. */
  threadMessages(threadTs: string): OutboundChatMessage[] {
    return this.outbox.filter((m) => m.threadTs === threadTs);
  }

  // ── APPROVAL SIMULATION: read the posted approval cards ─────────────────────────────────────────

  /**
   * Every approval card Atlas posted — an outbound message whose blocks include the approve button,
   * with the `jobId` (+ `decisionRecordId`) parsed out of the button's `value`. The caller resolves
   * the gate via `DecisionApprovalService.resolve(jobId, 'approve', ruledBy)`.
   */
  approvalCards(): CapturedApprovalCard[] {
    const cards: CapturedApprovalCard[] = [];
    for (const message of this.outbox) {
      const meta = parseApprovalMeta(message.blocks);
      if (meta) cards.push({ message, jobId: meta.jobId, ...(meta.decisionRecordId ? { decisionRecordId: meta.decisionRecordId } : {}) });
    }
    return cards;
  }

  /** The most recently posted approval card, if any. */
  latestApprovalCard(): CapturedApprovalCard | undefined {
    const cards = this.approvalCards();
    return cards.length ? cards[cards.length - 1] : undefined;
  }

  /**
   * Block until an approval card is posted (then return it). A script calls this after sending the
   * feature request + answering the grill, to grab the `jobId` it then approves. Resolves immediately
   * if a card was already posted.
   */
  async waitForApprovalCard(timeoutMs = 10_000): Promise<CapturedApprovalCard> {
    const existing = this.latestApprovalCard();
    if (existing) return existing;
    const message = await this.waitForReply((m) => !!parseApprovalMeta(m.blocks), timeoutMs);
    const meta = parseApprovalMeta(message.blocks)!;
    return { message, jobId: meta.jobId, ...(meta.decisionRecordId ? { decisionRecordId: meta.decisionRecordId } : {}) };
  }

  /** Clear the captured logs (between scripted scenarios in one boot). */
  reset(): void {
    this.outbox.length = 0;
  }

  private mintTs(): string {
    // Monotonic, Slack-ts-shaped (seconds.fraction) so anything keying on a ts string is happy.
    this.seq += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(this.seq).padStart(6, '0')}`;
  }
}

/**
 * Pull the `ApprovalActionMeta` out of an approval card's blocks: find the approve button, JSON-parse
 * its `value`. Returns undefined for any non-approval post. Pure — mirrors the block shape produced by
 * `decisionApprovalBlocks`.
 */
export function parseApprovalMeta(
  blocks: Array<Record<string, unknown>> | undefined,
): ApprovalActionMeta | undefined {
  if (!blocks) return undefined;
  for (const block of blocks) {
    if (block.type !== 'actions') continue;
    const elements = block.elements as Array<Record<string, unknown>> | undefined;
    if (!elements) continue;
    for (const el of elements) {
      if (el.action_id !== APPROVE_ACTION_ID) continue;
      const raw = el.value;
      if (typeof raw !== 'string') continue;
      try {
        const meta = JSON.parse(raw) as ApprovalActionMeta;
        if (meta && typeof meta.jobId === 'string') return meta;
      } catch {
        // not our card
      }
    }
  }
  return undefined;
}
