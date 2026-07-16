import { Logger } from '@nestjs/common';
import type { EventMessage, TurnEnvelope } from '@shared/domain';

/**
 * DI token the brain binds to — the single downstream of the intake seam (mirror of `CHAT_SURFACE` on
 * the other edge). The production binding lives in `brain/` and delegates to the thread's session. The
 * `LoggingBrainSink` below stays as a no-op fallback for headless composition.
 */
export const BRAIN_SINK = Symbol('BRAIN_SINK');

/**
 * The downstream of the intake seam: the thread brain. Two typed entry points instead of the old
 * `kind`-demuxed `Stimulus` union + router — a chat message continues a thread's session; an event is
 * delivered to its owning thread's brain as a harness message (a server-initiated turn). Keeping it a
 * port lets the whole intake pipeline — adapters → filter → route → deliver — be stood up and tested
 * with a no-op.
 */
export interface BrainSink {
  /**
   * A SYSTEM-SEED turn (an `ask_question`/`request_file` answer, a review-comments card, a reset-verify
   * kick) → run DIRECTLY as its own brain turn now. In-memory-only seeds (no durable `stimuli` row) don't
   * ride the durable delivery pump — they carry fields a re-drive from the DB row couldn't reconstruct.
   */
  handleChat(envelope: TurnEnvelope): Promise<void>;
  /**
   * A PERSISTED plain operator chat message → ensure durable delivery. Implementations enqueue it onto
   * the per-thread delivery pump (steer a live turn, or run a fresh one) and stamp `stimuli.delivered_at`
   * only once the brain positively took it; a leader sweep re-drives anything still undelivered. Does NOT
   * await the engine turn (intake stays fast; a swallowed/lost delivery self-heals via the sweep).
   */
  enqueueChat(envelope: TurnEnvelope): Promise<void>;
  /**
   * A routed event → delivered to its owning thread's brain as a harness message. Implementations make
   * this durable + at-least-once (the caller does NOT await the engine turn — the webhook 202 must stay fast).
   */
  deliverEvent(event: EventMessage): Promise<void>;
}

/**
 * A logging NO-OP sink — the fallback binding for headless composition. It makes the intake pipeline
 * observable (every surviving stimulus logs) without deciding anything. Production binds the brain.
 */
export class LoggingBrainSink implements BrainSink {
  private readonly logger = new Logger('BrainSink');

  async handleChat(envelope: TurnEnvelope): Promise<void> {
    this.logger.log(
      `[no-op] CHAT SEED ${envelope.id} thread=${envelope.jobId} ` +
        `author=${envelope.author.displayName} project=${envelope.repoId}`,
    );
  }

  async enqueueChat(envelope: TurnEnvelope): Promise<void> {
    this.logger.log(
      `[no-op] CHAT ${envelope.id} thread=${envelope.jobId} ` +
        `author=${envelope.author.displayName} project=${envelope.repoId}`,
    );
  }

  async deliverEvent(event: EventMessage): Promise<void> {
    this.logger.log(
      `[no-op] EVENT ${event.id} source=${event.source} severity=${event.severity} ` +
        `thread=${event.jobId} project=${event.repoId} (untrusted)`,
    );
  }
}
