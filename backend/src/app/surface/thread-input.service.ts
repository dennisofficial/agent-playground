import { Injectable, Logger } from '@nestjs/common';
import { descriptorForLane, type ThreadKind } from './thread-registry';

/**
 * The context a post-handler needs to deliver a message — the owning job plus the ids the registry captured
 * from the lane (e.g. a builder lane's threadId). `ids` mirrors {@link ThreadDescriptor.match}'s output.
 */
export interface PostCtx {
  jobId: string;
  orgId: string;
  repoId: string;
  /** The human who authored the message, for transcript attribution. Absent for programmatic posters, which
   *  fall back to a System author (so those callers stay byte-identical to before this field existed). */
  author?: { id: string; displayName: string };
}

/** A registered transport for one input-accepting thread kind (`input: 'operator' | 'agent'`). */
export interface ThreadInputHandler {
  post(ctx: PostCtx & { ids: string[] }, message: string): Promise<void>;
}

/**
 * THE SHARED SEND SEAM — one entry point for "deliver a message into the thread that owns this lane",
 * regardless of thread kind. It does NOT reimplement any transport: each input-accepting kind REGISTERS its
 * existing transport (the Main brain's durable steer/fresh-turn pump; the Codex review dialogue's
 * resume-with-reply), and {@link postToThread} routes to it via the {@link THREAD_REGISTRY} single source of
 * truth. Read-only lanes (`input: 'none'` — builders, autofix, ship) have no handler and a post throws
 * rather than silently no-op'ing.
 *
 * Registration (not constructor injection) keeps the wiring acyclic: this service lives in the @Global
 * surface spine and depends on NOTHING; the brain services depend on it and register themselves at boot.
 */
@Injectable()
export class ThreadInputService {
  private readonly logger = new Logger(ThreadInputService.name);
  private readonly handlers = new Map<ThreadKind, ThreadInputHandler>();

  /** Register a kind's transport. Called once per input-accepting service at boot (idempotent overwrite). */
  register(kind: ThreadKind, handler: ThreadInputHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Whether a lane's thread can currently accept a message (a registered, non-read-only handler exists). */
  canPost(lane: string): boolean {
    const hit = descriptorForLane(lane);
    return Boolean(
      hit && hit.descriptor.input !== 'none' && this.handlers.has(hit.descriptor.kind),
    );
  }

  /**
   * Deliver `message` into whatever thread owns `lane`. Throws for an unknown lane, a read-only kind
   * (`input: 'none'`), or an input-accepting kind whose handler hasn't registered yet (a boot-order bug).
   */
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
