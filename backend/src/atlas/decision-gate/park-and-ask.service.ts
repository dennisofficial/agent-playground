import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import {
  CHAT_SURFACE,
  type ChatSurface,
  type InboundChatMessage,
} from '../surface';

/**
 * Where to park-and-ask: a thread reference Atlas talks back into. The section is parked ON this
 * thread; the human's next reply IN this thread resolves it.
 */
export interface ParkTarget {
  /** Surface-native channel coordinate (e.g. a Slack channel id 'C042'). */
  channel: string;
  /** The thread root ts the question is posted into. Omit to post top-level (and seed a new thread). */
  threadTs?: string;
  /** The tenant to post as (selects the workspace credentials). */
  orgId?: string;
}

/** A live park — the question is posted, the section is suspended awaiting a human reply. */
export interface ParkHandle {
  /** Stable id for this park (so a caller can correlate / cancel). */
  readonly id: string;
  /** The ts of the posted question message (also the thread root if one was seeded). */
  readonly questionTs: string | undefined;
  /** The thread the park is bound to (the seeded or provided root ts). */
  readonly threadTs: string | undefined;
  /**
   * Resolves when the human replies in the thread (or rejects on `cancel`). The driver can `await`
   * this to block the section, OR ignore it and poll `resolved`/`resolution` (non-blocking).
   */
  readonly answer: Promise<ParkResolution>;
  /** Non-blocking peek: has a reply landed yet? */
  readonly resolved: boolean;
  /** The reply, once resolved (undefined while still parked). */
  readonly resolution?: ParkResolution;
}

/** The human's resolving reply. */
export interface ParkResolution {
  parkId: string;
  /** The reply text (the human's answer to the parked question). */
  text: string;
  /** Who replied. */
  authorId: string;
  /** The reply message's ts. */
  ts: string;
}

interface ParkState {
  id: string;
  channel: string;
  threadTs?: string;
  questionTs?: string;
  question: string;
  createdAt: Date;
  resolved: boolean;
  resolution?: ParkResolution;
  resolve: (r: ParkResolution) => void;
  reject: (e: Error) => void;
}

/**
 * W5 — the PARK-AND-ASK mechanism. When the classifier returns `ask`, the section driver hands the
 * question here; this service:
 *   1. POSTS the question into the target thread via the `ChatSurface` (seeding a thread if none yet);
 *   2. returns a `ParkHandle` whose `answer` promise resolves when the HUMAN replies IN that thread;
 *   3. matches the resolving reply by `threadTs` off the surface's `inbound$`.
 *
 * Non-blocking by contract: the driver may `await handle.answer` (suspend the section) OR poll
 * `handle.resolved` / `handle.resolution` and keep other sections moving — the section is "parked",
 * not the process.
 *
 * DURABILITY SEAM: park state is IN-MEMORY (a `Map`), so a restart drops in-flight parks. The rules for
 * this round forbid adding/editing entities + migrations (owned by other workstreams), so durability is
 * deferred behind this clear seam: persist `ParkState` to an `atlas_*` row on `register`, rehydrate +
 * re-subscribe on boot, and clear on `resolve`. The public API (`ask`/`ParkHandle`) does not change
 * when that lands. Zero v1 imports.
 */
@Injectable()
export class ParkAndAskService implements OnModuleDestroy {
  private readonly logger = new Logger(ParkAndAskService.name);
  private readonly parks = new Map<string, ParkState>();
  private inboundSub?: Subscription;

  constructor(@Inject(CHAT_SURFACE) private readonly surface: ChatSurface) {
    // Single subscription routes every thread reply to the matching park.
    this.inboundSub = this.surface.inbound$.subscribe((msg) =>
      this.onInbound(msg),
    );
  }

  onModuleDestroy(): void {
    this.inboundSub?.unsubscribe();
    // Reject any still-parked questions so awaiting drivers don't hang forever.
    for (const park of this.parks.values()) {
      if (!park.resolved) park.reject(new Error('Atlas shutting down — park abandoned.'));
    }
    this.parks.clear();
  }

  /**
   * Park a section and ask the human a question in the target thread. Posts the question, registers the
   * park, and returns the handle. If `target.threadTs` is omitted the post seeds a NEW thread and the
   * park binds to the seeded root.
   */
  async ask(target: ParkTarget, question: string): Promise<ParkHandle> {
    const id = randomUUID();
    const questionTs = await this.surface.post(target.channel, question, {
      ...(target.threadTs ? { threadTs: target.threadTs } : {}),
      ...(target.orgId ? { orgId: target.orgId } : {}),
    });
    // Bind the park to the thread root: the provided root, else the seeded post's own ts.
    const threadTs = target.threadTs ?? questionTs;

    let resolve!: (r: ParkResolution) => void;
    let reject!: (e: Error) => void;
    const answer = new Promise<ParkResolution>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const state: ParkState = {
      id,
      channel: target.channel,
      ...(threadTs ? { threadTs } : {}),
      ...(questionTs ? { questionTs } : {}),
      question,
      createdAt: new Date(),
      resolved: false,
      resolve: (r) => {
        state.resolved = true;
        state.resolution = r;
        resolve(r);
      },
      reject,
    };
    this.parks.set(id, state);
    this.logger.log(`parked ${id} on thread ${threadTs ?? '(unseeded)'} — awaiting human reply`);

    // DURABILITY SEAM: persist `state` here when a table lands (see class doc).

    return {
      id,
      questionTs,
      threadTs,
      answer,
      get resolved() {
        return state.resolved;
      },
      get resolution() {
        return state.resolution;
      },
    };
  }

  /** Number of parks still awaiting a reply (diagnostics / driver bookkeeping). */
  get pending(): number {
    let n = 0;
    for (const p of this.parks.values()) if (!p.resolved) n++;
    return n;
  }

  /** Abandon a park (e.g. the section was cancelled). Rejects its `answer` and drops it. */
  cancel(parkId: string, reason = 'park cancelled'): void {
    const park = this.parks.get(parkId);
    if (!park) return;
    if (!park.resolved) park.reject(new Error(reason));
    this.parks.delete(parkId);
  }

  /** Route an inbound thread reply to the FIRST unresolved park bound to its thread. */
  private onInbound(msg: InboundChatMessage): void {
    // Only thread replies resolve a park; a top-level message isn't an answer to a parked question.
    if (!msg.threadTs) return;
    for (const park of this.parks.values()) {
      if (park.resolved) continue;
      if (park.channel !== msg.channel) continue;
      if (park.threadTs !== msg.threadTs) continue;
      // Don't resolve on the question we ourselves posted (defensive — surfaces shouldn't echo).
      if (park.questionTs && msg.id === park.questionTs) continue;
      const resolution: ParkResolution = {
        parkId: park.id,
        text: msg.text,
        authorId: msg.authorId,
        ts: msg.id,
      };
      this.logger.log(`park ${park.id} resolved by ${msg.authorId}`);
      park.resolve(resolution);
      this.parks.delete(park.id);
      // DURABILITY SEAM: delete the persisted row here when it lands.
      return;
    }
  }
}
