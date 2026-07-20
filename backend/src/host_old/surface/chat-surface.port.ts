import type { Observable } from 'rxjs';
import type { SeedRow } from '../../_shared/domain/seed-row';
import type { AgentMessage } from '../../_shared/prompt-kit/message';

import { renderChunk } from '../../_shared/stimulus/chunk-vocabulary';

export const CHAT_SURFACE = Symbol('CHAT_SURFACE');

export interface InboundChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  orgId: string;
  channel: string;
  threadTs?: string;
  ts: Date;
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

export interface PostOptions {
  threadTs?: string;
  blocks?: Array<Record<string, unknown>>;
  orgId?: string;
  meta?: Record<string, unknown>;
}

export const SYSTEM_SEED_AUTHOR = { id: 'U-SYSTEM', name: 'System' } as const;

export function wrapSystemNotification(body: AgentMessage): string {
  return renderChunk({ kind: 'system_notice', body });
}

export interface ChatSurface {
  readonly name: string; // 'web' | 'agent'
  readonly inbound$: Observable<InboundChatMessage>;
  post(channel: string, text: string, opts?: PostOptions): Promise<string | undefined>;
  update?(
    channel: string,
    ts: string,
    args: { text?: string; blocks?: Array<Record<string, unknown>> },
    orgId?: string,
  ): Promise<void> | void;
  readonly resumeRequests$?: Observable<{ jobId: string }>;
  emitThreadMeta?(channel: string, jobId: string, title: string): void;
  seedSystemNotification?(
    channel: string,
    jobId: string,
    body: AgentMessage,
    opts?: {
      orgId?: string;
      deliveredQuestionId?: string;
      deliveredFileId?: string;
      deliveredSecretId?: string;
      deliveredQuestionIds?: string[];
      deliveredFileIds?: string[];
      deliveredSecretIds?: string[];
      seedRow?: SeedRow;
      lane?: string;
    },
  ): string;
}
