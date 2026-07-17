import { Injectable, Logger } from '@nestjs/common';
import type { SeedRow } from '@shared/domain';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { firstValueFrom, Observable, Subject, timeout } from 'rxjs';
import { filter, first } from 'rxjs/operators';
import { APPROVE_ACTION_ID, type ApprovalActionMeta } from '../surface/approval-blocks';
import type { ChatSurface, InboundChatMessage, PostOptions } from '../surface/chat-surface.port';
import { SYSTEM_SEED_AUTHOR, wrapSystemNotification } from '../surface/chat-surface.port';

export interface OutboundChatMessage {
  ts: string;
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: Array<Record<string, unknown>>;
  postedAt: Date;
}

export interface SendOptions {
  threadTs?: string;
  authorId?: string;
  authorName?: string;
  orgId?: string;
  priority?: 'now' | 'queue' | 'later';
}

export interface CapturedApprovalCard {
  message: OutboundChatMessage;
  jobId: string;
  decisionRecordId?: string;
}

const DEFAULT_TEAM_ID = 'a0a0a0a0-0000-4000-8000-000000000002'; // sentinel org uuid (agent default tenant)
const DEFAULT_AUTHOR_ID = 'U-DENNIS';
const DEFAULT_AUTHOR_NAME = 'Dennis';

@Injectable()
export class AgentChatSurface implements ChatSurface {
  readonly name = 'agent';
  private readonly logger = new Logger(AgentChatSurface.name);

  private readonly inboundSubject = new Subject<InboundChatMessage>();
  private readonly outboundSubject = new Subject<OutboundChatMessage>();

  readonly outbox: OutboundChatMessage[] = [];

  private seq = 0;
  private readonly orgId = DEFAULT_TEAM_ID;

  get inbound$(): Observable<InboundChatMessage> {
    return this.inboundSubject.asObservable();
  }

  get outbound$(): Observable<OutboundChatMessage> {
    return this.outboundSubject.asObservable();
  }


  sendFromHuman(channel: string, text: string, opts: SendOptions = {}): string {
    const ts = this.mintTs();
    const message: InboundChatMessage = {
      id: ts,
      authorId: opts.authorId ?? DEFAULT_AUTHOR_ID,
      authorName: opts.authorName ?? DEFAULT_AUTHOR_NAME,
      text,
      orgId: opts.orgId ?? this.orgId,
      channel,
      ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ts: new Date(),
    };
    this.logger.debug(
      `sendFromHuman → ${channel}${opts.threadTs ? ` (thread ${opts.threadTs})` : ''}: ${text.slice(0, 80)}`,
    );
    this.inboundSubject.next(message);
    return ts;
  }

  seedSystemNotification(
    channel: string,
    jobId: string,
    body: AgentMessage,
    opts: {
      orgId?: string;
      deliveredQuestionId?: string;
      deliveredFileId?: string;
      deliveredSecretId?: string;
      seedRow?: SeedRow;
      lane?: string;
    } = {},
  ): string {
    if (opts.lane && opts.lane !== 'main') {
      throw new Error(
        `AgentChatSurface.seedSystemNotification: build-lane seeds must route via the LaneSeeder, not the surface (lane=${opts.lane})`,
      );
    }
    const ts = this.mintTs();
    this.inboundSubject.next({
      id: ts,
      authorId: SYSTEM_SEED_AUTHOR.id,
      authorName: SYSTEM_SEED_AUTHOR.name,
      text: wrapSystemNotification(body),
      orgId: opts.orgId ?? this.orgId,
      channel,
      threadTs: jobId,
      ts: new Date(),
      seed: true,
      ...(opts.deliveredQuestionId ? { seedQuestionId: opts.deliveredQuestionId } : {}),
      ...(opts.deliveredFileId ? { seedFileId: opts.deliveredFileId } : {}),
      ...(opts.deliveredSecretId ? { seedSecretId: opts.deliveredSecretId } : {}),
      ...(opts.seedRow ? { seedRow: opts.seedRow } : {}),
    });
    return ts;
  }


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


  waitForReply(
    predicate: (m: OutboundChatMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<OutboundChatMessage> {
    return firstValueFrom(
      this.outbound$.pipe(filter(predicate), first(), timeout({ each: timeoutMs })),
    );
  }

  threadMessages(threadTs: string): OutboundChatMessage[] {
    return this.outbox.filter((m) => m.threadTs === threadTs);
  }


  approvalCards(): CapturedApprovalCard[] {
    const cards: CapturedApprovalCard[] = [];
    for (const message of this.outbox) {
      const meta = parseApprovalMeta(message.blocks);
      if (meta)
        cards.push({
          message,
          jobId: meta.jobId,
          ...(meta.decisionRecordId ? { decisionRecordId: meta.decisionRecordId } : {}),
        });
    }
    return cards;
  }

  latestApprovalCard(): CapturedApprovalCard | undefined {
    const cards = this.approvalCards();
    return cards.length ? cards[cards.length - 1] : undefined;
  }

  async waitForApprovalCard(timeoutMs = 10_000): Promise<CapturedApprovalCard> {
    const existing = this.latestApprovalCard();
    if (existing) return existing;
    const message = await this.waitForReply((m) => !!parseApprovalMeta(m.blocks), timeoutMs);
    const meta = parseApprovalMeta(message.blocks)!;
    return {
      message,
      jobId: meta.jobId,
      ...(meta.decisionRecordId ? { decisionRecordId: meta.decisionRecordId } : {}),
    };
  }

  reset(): void {
    this.outbox.length = 0;
  }

  private mintTs(): string {
    this.seq += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(this.seq).padStart(6, '0')}`;
  }
}

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
      }
    }
  }
  return undefined;
}
