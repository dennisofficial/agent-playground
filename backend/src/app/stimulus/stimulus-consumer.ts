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
  /** A human chat message continuing an existing thread → that thread's brain session. */
  handleChat(stimulus: ChatStimulus): Promise<void>;
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
