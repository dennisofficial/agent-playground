import { Logger } from '@nestjs/common';
import type { Stimulus } from '../domain';

/**
 * DI token the downstream consumer binds to — exactly like `CHAT_SURFACE` on the other edge. The
 * production binding is `StimulusRouter` (in `brain/`), which demuxes chat → the thread's brain session
 * and event → `EventTriageService`. The `LoggingStimulusConsumer` below stays as a no-op fallback for
 * headless composition.
 */
export const STIMULUS_CONSUMER = Symbol('STIMULUS_CONSUMER');

/**
 * The downstream of the intake seam: a single `consume(stimulus)` the normalized + filtered stimuli
 * flow into. Keeping it a port lets the whole intake pipeline — adapters → filter → seed → consume —
 * be stood up and tested with a no-op.
 *
 * NOTE — slated for rework: see `../ARCHITECTURE.md` §7 (the union + router are leftover indirection).
 */
export interface StimulusConsumer {
  /** Called once per surviving stimulus (chat or event), after normalization + persistence. */
  consume(stimulus: Stimulus): Promise<void>;
}

/**
 * A logging NO-OP consumer — the fallback binding for headless composition. It makes the intake pipeline
 * observable (every surviving stimulus logs its kind/source/severity/thread) without deciding anything.
 * Production binds `StimulusRouter` instead.
 */
export class LoggingStimulusConsumer implements StimulusConsumer {
  private readonly logger = new Logger('StimulusConsumer');

  async consume(stimulus: Stimulus): Promise<void> {
    if (stimulus.kind === 'event') {
      this.logger.log(
        `[no-op consume] EVENT ${stimulus.id} source=${stimulus.source} ` +
          `severity=${stimulus.severity} project=${stimulus.repoId} ` +
          `dedupeKey=${stimulus.dedupeKey} (untrusted) — W3 triage will handle this`,
      );
    } else {
      this.logger.log(
        `[no-op consume] CHAT ${stimulus.id} thread=${stimulus.threadId} ` +
          `author=${stimulus.author.displayName} project=${stimulus.repoId} — W3 triage will handle this`,
      );
    }
  }
}
