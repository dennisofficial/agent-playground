import { Logger } from '@nestjs/common';
import type { ChatStimulus, EventStimulus } from '../domain';

/**
 * DI token the brain binds to — the single downstream of the intake seam (mirror of `CHAT_SURFACE` on
 * the other edge). The production binding lives in `brain/` and delegates to the thread's session. The
 * `LoggingBrainSink` below stays as a no-op fallback for headless composition.
 */
export const BRAIN_SINK = Symbol('BRAIN_SINK');

/**
 * The downstream of the intake seam: the thread brain. Two typed entry points instead of the old
 * `kind`-demuxed `Stimulus` union + router — a chat message continues a thread's session; an event is
 * delivered to its freshly-seeded thread's brain as a harness message (a server-initiated turn).
 * Keeping it a port lets the whole intake pipeline — adapters → filter → seed → deliver — be stood up
 * and tested with a no-op.
 */
export interface BrainSink {
  /**
   * A SYSTEM-SEED chat stimulus (an `ask_question`/`request_file` answer, a review-comments card, a
   * reset-verify kick) → run DIRECTLY as its own brain turn now. Seeds are in-memory only (never a
   * durable `stimuli` row), so they don't ride the durable delivery pump — they carry in-memory-only
   * fields (`seedQuestionId`/`card`/…) a re-drive from the DB row couldn't reconstruct.
   */
  handleChat(stimulus: ChatStimulus): Promise<void>;
  /**
   * A PERSISTED plain operator chat message → ensure durable delivery. Implementations enqueue it onto
   * the per-thread delivery pump (steer a live turn, or run a fresh one) and stamp `stimuli.delivered_at`
   * only once the brain positively took it; a leader sweep re-drives anything still undelivered. Does NOT
   * await the engine turn (intake stays fast; a swallowed/lost delivery self-heals via the sweep).
   */
  enqueueChat(stimulus: ChatStimulus): Promise<void>;
  /**
   * A seeded event → delivered to its thread's brain as a harness message. Implementations make this
   * durable + at-least-once (the caller does NOT await the engine turn — the webhook 202 must stay fast).
   */
  deliverEvent(stimulus: EventStimulus): Promise<void>;
}

/**
 * A logging NO-OP sink — the fallback binding for headless composition. It makes the intake pipeline
 * observable (every surviving stimulus logs) without deciding anything. Production binds the brain.
 */
export class LoggingBrainSink implements BrainSink {
  private readonly logger = new Logger('BrainSink');

  async handleChat(stimulus: ChatStimulus): Promise<void> {
    this.logger.log(
      `[no-op] CHAT SEED ${stimulus.id} thread=${stimulus.jobId} ` +
        `author=${stimulus.author.displayName} project=${stimulus.repoId}`,
    );
  }

  async enqueueChat(stimulus: ChatStimulus): Promise<void> {
    this.logger.log(
      `[no-op] CHAT ${stimulus.id} thread=${stimulus.jobId} ` +
        `author=${stimulus.author.displayName} project=${stimulus.repoId}`,
    );
  }

  async deliverEvent(stimulus: EventStimulus): Promise<void> {
    this.logger.log(
      `[no-op] EVENT ${stimulus.id} source=${stimulus.source} severity=${stimulus.severity} ` +
        `thread=${stimulus.jobId} project=${stimulus.repoId} (untrusted)`,
    );
  }
}
