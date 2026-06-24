import { Logger } from '@nestjs/common';
import type { Stimulus } from '../domain';

/**
 * DI token a hosting app (W3) binds its triage consumer to — exactly like `CHAT_SURFACE` on the other
 * edge. W2 ships the logging no-op below as the default binding so the pipeline is observable
 * end-to-end; W3 overrides it with `{ provide: STIMULUS_CONSUMER, useExisting: TriageService }`.
 */
export const STIMULUS_CONSUMER = Symbol('STIMULUS_CONSUMER');

/**
 * The downstream of the intake seam: a single `consume(stimulus)` the normalized + filtered stimuli
 * flow into. W3's triage (ignore / ask / dispatch) implements this. Keeping it a port means W2 can
 * stand the whole intake pipeline up — adapters → filter → seed → consume — and prove it end-to-end
 * with a no-op, before any brain exists.
 */
export interface StimulusConsumer {
  /** Called once per surviving stimulus (chat or event), after normalization + persistence. */
  consume(stimulus: Stimulus): Promise<void>;
}

/**
 * The W2 default consumer — a logging NO-OP. It makes the intake pipeline observable (every surviving
 * stimulus logs its kind/source/severity/thread) without deciding anything. W3 replaces it with real
 * triage; until then this proves the seam is wired and stimuli reach the brain's doorstep.
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
