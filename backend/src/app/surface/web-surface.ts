import { Injectable, Logger } from '@nestjs/common';
import type { SeedRow } from '@shared/domain/seed-row';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { Observable, Subject } from 'rxjs';
import type { ApprovalDecision } from './approval-blocks';
import { APPROVE_ACTION_ID } from './approval-blocks';
import type { ChatSurface, InboundChatMessage, PostOptions } from './chat-surface.port';
import { SYSTEM_SEED_AUTHOR, wrapSystemNotification } from './chat-surface.port';
import type { MessageChangeNotifier } from './message-change-notifier.port';
import type { WebApprovalCard } from './web-approval-card';
import { webApprovalCard } from './web-approval-card';

export interface WebOutboundMessage {
  ts: string;
  channel: string;
  text: string;
  threadTs?: string;
  card?: WebApprovalCard;
  meta?: Record<string, unknown>;
  postedAt: Date;
}

export interface WebInboundOptions {
  threadTs?: string;
  authorId?: string;
  authorName?: string;
  orgId?: string;
  seed?: boolean;
  seedQuestionId?: string;
  seedFileId?: string;
  seedSecretId?: string;
  seedQuestionIds?: string[];
  seedFileIds?: string[];
  seedSecretIds?: string[];
  seedRow?: SeedRow;
  priority?: 'now' | 'queue' | 'later';
  card?: Record<string, unknown>;
}

const DEFAULT_TEAM_ID = 'a0a0a0a0-0000-4000-8000-000000000001'; // sentinel org uuid (web default tenant)
const DEFAULT_AUTHOR_ID = 'U-OPERATOR';
const DEFAULT_AUTHOR_NAME = 'Operator';

@Injectable()
export class WebSurface implements ChatSurface, MessageChangeNotifier {
  readonly name = 'web';
  private readonly logger = new Logger(WebSurface.name);

  private readonly inboundSubject = new Subject<InboundChatMessage>();
  private readonly outboundSubject = new Subject<WebOutboundMessage>();
  private readonly approvalSubject = new Subject<{
    actionId: string;
    value: string;
    ruledBy: string;
    note?: string;
  }>();
  private readonly resumeSubject = new Subject<{ jobId: string }>();
  private readonly threadMetaSubject = new Subject<{
    channel: string;
    jobId: string;
    title: string;
  }>();
  private readonly messagesChangedSubject = new Subject<{
    channel: string;
    jobId: string;
  }>();

  readonly outbox: WebOutboundMessage[] = [];

  private seq = 0;
  private readonly defaultTeamId = DEFAULT_TEAM_ID;

  get inbound$(): Observable<InboundChatMessage> {
    return this.inboundSubject.asObservable();
  }

  get outbound$(): Observable<WebOutboundMessage> {
    return this.outboundSubject.asObservable();
  }

  get approval$(): Observable<{
    actionId: string;
    value: string;
    ruledBy: string;
    note?: string;
  }> {
    return this.approvalSubject.asObservable();
  }

  get resumeRequests$(): Observable<{ jobId: string }> {
    return this.resumeSubject.asObservable();
  }

  get threadMeta$(): Observable<{
    channel: string;
    jobId: string;
    title: string;
  }> {
    return this.threadMetaSubject.asObservable();
  }

  emitThreadMeta(channel: string, jobId: string, title: string): void {
    this.threadMetaSubject.next({ channel, jobId, title });
  }

  get messagesChanged$(): Observable<{ channel: string; jobId: string }> {
    return this.messagesChangedSubject.asObservable();
  }

  emitMessagesChanged(repoId: string, jobId: string): void {
    this.messagesChangedSubject.next({ channel: repoId, jobId });
  }

  requestResume(jobId: string): void {
    this.logger.debug(`requestResume job=${jobId}`);
    this.resumeSubject.next({ jobId });
  }


  receiveFromClient(channel: string, text: string, opts: WebInboundOptions = {}): string {
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
      ...(opts.seedFileId ? { seedFileId: opts.seedFileId } : {}),
      ...(opts.seedSecretId ? { seedSecretId: opts.seedSecretId } : {}),
      ...(opts.seedQuestionIds?.length ? { seedQuestionIds: opts.seedQuestionIds } : {}),
      ...(opts.seedFileIds?.length ? { seedFileIds: opts.seedFileIds } : {}),
      ...(opts.seedSecretIds?.length ? { seedSecretIds: opts.seedSecretIds } : {}),
      ...(opts.seedRow ? { seedRow: opts.seedRow } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.card ? { card: opts.card } : {}),
      ts: new Date(),
    };
    this.logger.debug(
      `receiveFromClient → ${channel}${opts.threadTs ? ` (thread ${opts.threadTs})` : ''}: ${text.slice(0, 80)}`,
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
      deliveredQuestionIds?: string[];
      deliveredFileIds?: string[];
      deliveredSecretIds?: string[];
      seedRow?: SeedRow;
      lane?: string;
    } = {},
  ): string {
    if (opts.lane && opts.lane !== 'main') {
      throw new Error(
        `WebSurface.seedSystemNotification: build-lane seeds must route via the LaneSeeder, not the surface (lane=${opts.lane})`,
      );
    }
    return this.receiveFromClient(channel, wrapSystemNotification(body), {
      threadTs: jobId,
      seed: true,
      authorId: SYSTEM_SEED_AUTHOR.id,
      authorName: SYSTEM_SEED_AUTHOR.name,
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.deliveredQuestionId ? { seedQuestionId: opts.deliveredQuestionId } : {}),
      ...(opts.deliveredFileId ? { seedFileId: opts.deliveredFileId } : {}),
      ...(opts.deliveredSecretId ? { seedSecretId: opts.deliveredSecretId } : {}),
      ...(opts.deliveredQuestionIds?.length ? { seedQuestionIds: opts.deliveredQuestionIds } : {}),
      ...(opts.deliveredFileIds?.length ? { seedFileIds: opts.deliveredFileIds } : {}),
      ...(opts.deliveredSecretIds?.length ? { seedSecretIds: opts.deliveredSecretIds } : {}),
      ...(opts.seedRow ? { seedRow: opts.seedRow } : {}),
    });
  }

  receiveApprovalClick(actionId: string, value: string, ruledBy: string, note?: string): void {
    this.logger.debug(`receiveApprovalClick action=${actionId} ruledBy=${ruledBy}`);
    this.approvalSubject.next({
      actionId,
      value,
      ruledBy,
      ...(note ? { note } : {}),
    });
  }


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

  update(channel: string, ts: string, args: { text?: string; card?: WebApprovalCard }): void {
    const entry = this.outbox.find((m) => m.channel === channel && m.ts === ts);
    if (entry) {
      if (args.text !== undefined) entry.text = args.text;
      if (args.card !== undefined) entry.card = args.card;
      this.outboundSubject.next({ ...entry });
    }
  }


  channelMessages(channel: string, threadTs?: string): WebOutboundMessage[] {
    return this.outbox.filter(
      (m) => m.channel === channel && (threadTs === undefined || m.threadTs === threadTs),
    );
  }

  reset(): void {
    this.outbox.length = 0;
  }

  private mintTs(): string {
    this.seq += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(this.seq).padStart(6, '0')}`;
  }
}


function detectAndConvertApprovalCard(
  blocks: Array<Record<string, unknown>>,
  text: string,
): WebApprovalCard | undefined {
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
      }
    }
  }
  if (!meta) return undefined;

  let summary = '';
  const threads: string[] = [];
  let decisions: ApprovalDecision[] = [];
  let planUrl: string | undefined;
  let kind: 'plan' | 'direct' = 'plan';
  let title = text.replace(/^(?:Plan proposal|Direct build)\s*[—-]\s*/, '').trim() || text;

  for (const block of blocks) {
    if (block.type === 'thread') {
      const t = block.text as Record<string, unknown> | undefined;
      const raw = typeof t?.text === 'string' ? (t.text as string) : '';
      if (raw.startsWith('*Plan proposal') || raw.startsWith('*Direct build')) {
        kind = raw.startsWith('*Direct build') ? 'direct' : 'plan';
        const match = /(?:Plan proposal|Direct build)\s*[—-]\s*(.+)\*$/.exec(raw);
        if (match) title = match[1].trim();
      } else if (!summary) {
        summary = raw;
      } else if (raw.startsWith('*Threads*') || raw.startsWith('*Changes*')) {
        const lines = raw.split('\n').slice(1); // drop the "*Threads*"/"*Changes*" header line
        for (const line of lines) {
          const m = /^\d+\.\s+(.+)$/.exec(line.trim());
          if (m) threads.push(m[1]);
        }
      } else if (raw.startsWith('*Decisions*')) {
        const lines = raw.split('\n').slice(1);
        for (const line of lines) {
          const m =
            /^•\s+(?:\[(confirmed|authored)\]\s+)?\*(.+?)\*\s+_\((.+?)\)_\s+[—-]\s+(.+)$/.exec(
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
