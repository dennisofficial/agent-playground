import { Injectable, Logger } from '@nestjs/common';
import { descriptorForLane, type ThreadKind } from './thread-registry';

export interface PostCtx {
  jobId: string;
  orgId: string;
  repoId: string;
  author?: { id: string; displayName: string };
}

export interface ThreadInputHandler {
  post(ctx: PostCtx & { ids: string[] }, message: string): Promise<void>;
}

@Injectable()
export class ThreadInputService {
  private readonly logger = new Logger(ThreadInputService.name);
  private readonly handlers = new Map<ThreadKind, ThreadInputHandler>();

  register(kind: ThreadKind, handler: ThreadInputHandler): void {
    this.handlers.set(kind, handler);
  }

  canPost(lane: string): boolean {
    const hit = descriptorForLane(lane);
    return Boolean(
      hit && hit.descriptor.input !== 'none' && this.handlers.has(hit.descriptor.kind),
    );
  }

  async postToThread(lane: string, ctx: PostCtx, message: string): Promise<void> {
    const hit = descriptorForLane(lane);
    if (!hit) throw new Error(`postToThread: no thread kind owns lane "${lane}"`);
    const { descriptor, ids } = hit;
    if (descriptor.input === 'none') {
      throw new Error(`postToThread: ${descriptor.kind} threads are read-only (lane "${lane}")`);
    }
    const handler = this.handlers.get(descriptor.kind);
    if (!handler) {
      throw new Error(`postToThread: no input handler registered for ${descriptor.kind}`);
    }
    await handler.post({ ...ctx, ids }, message);
  }
}
