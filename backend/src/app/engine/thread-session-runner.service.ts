import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isSessionLimitError } from '@shared/engine';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity } from '../persistence/entities';

/**
 * The DISPLAY-ONLY labels a dormant thread carries after an abnormal turn end (d8):
 *  - `session_limit` — the turn ended cleanly on a Claude subscription/usage limit.
 *  - `error` — the turn threw (infra/transport/engine failure).
 *  - `incomplete` — the turn ended WITHOUT `complete_thread` (a clean stop, not a throw).
 * `null` clears the label. It never drives auto-resume; a thread is woken only by an operator
 * message or a subscribed host event.
 */
export type ThreadHaltReason = 'session_limit' | 'error' | 'incomplete';

/** The subset of {@link ThreadHaltReason} a THROWN turn-ending error resolves to. */
export type ThrownHaltReason = Extract<ThreadHaltReason, 'session_limit' | 'error'>;

/**
 * The shared per-thread session-turn primitive both execution engines route through — the brain
 * (`AgentSessionManager`, planner/codex_review/post_build/ship roles) and the headless driver
 * (`ThreadDriver`, builder/master_review/review_agent/review_fix roles).
 *
 * Phase A centralizes the ONE piece the two engines implemented byte-for-byte identically: the
 * DISPLAY-ONLY `threads.halt_reason` lifecycle (§8 / d8) — clear it when a turn (re)starts, classify a
 * thrown ending, and set the label without ever letting a persistence hiccup break the live turn.
 *
 * It owns its own `ThreadEntity` repository (like its sibling {@link TurnRunnerService}) so it stays
 * decoupled from either engine's store and carries no cross-module dependency.
 */
@Injectable()
export class ThreadSessionRunnerService {
  private readonly logger = new Logger(ThreadSessionRunnerService.name);

  constructor(
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
  ) {}

  /**
   * Set (or, with `null`, clear) the thread's DISPLAY-ONLY `halt_reason`. Best-effort: any write error is
   * swallowed with a debug log — the label only mis-explains a dormant thread until its next turn clears
   * it, so it must NEVER block or fail a turn (also tolerant of a store schema that predates the column).
   */
  async markHalt(
    threadId: string,
    reason: ThreadHaltReason | null,
  ): Promise<void> {
    try {
      await this.threads.update({ id: threadId }, { halt_reason: reason });
    } catch (err) {
      this.logger.debug(
        `setThreadHaltReason(${reason ?? 'clear'}) failed (display-only): ${errText(err)}`,
      );
    }
  }

  /**
   * Classify a THROWN turn-ending error into its display label: a clean session/usage-limit end reads as
   * `session_limit`, everything else as `error`. Pure — the caller decides whether to skip labelling
   * (e.g. a detached/draining end is the engine still living, not a halt).
   */
  classifyThrownHalt(err: unknown): ThrownHaltReason {
    return isSessionLimitError(err) ? 'session_limit' : 'error';
  }

  /** Classify a thrown ending and set the label in one step, returning the reason written. */
  async noteThrownHalt(
    threadId: string,
    err: unknown,
  ): Promise<ThrownHaltReason> {
    const reason = this.classifyThrownHalt(err);
    await this.markHalt(threadId, reason);
    return reason;
  }
}

/** Compact single-line rendering of an arbitrary error for the swallow-and-log path. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
