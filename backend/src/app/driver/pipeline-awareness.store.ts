import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import type {
  PipelineMarker,
  ThreadPipelineAwareness,
} from '../persistence/entities/job.entity';

/**
 * PASSIVE pipeline-milestone awareness — the DURABLE half. Owns the `threads.pipeline_awareness` jsonb
 * buffer: build thread groups APPEND milestones here (no turn runs), and the next OPERATOR turn DRAINS them.
 *
 * Concurrency is the whole point: the driver runs fire-and-forget OUTSIDE the brain's per-thread turn
 * queue, so an `appendMarker` (driver) and a `drainAndAdvance` (a human turn) can race on the same row.
 * Both run as a single `SELECT … FOR UPDATE` + write transaction, so they serialize on the thread row —
 * a human turn arriving mid-build can't read-clear the queue while the driver is appending to it, and no
 * marker is dropped. Idempotent append (dedup by `id`) means the driver firing the same milestone twice
 * (it emits many events per step) keeps exactly one.
 */
@Injectable()
export class PipelineAwarenessStore {
  private readonly logger = new Logger(PipelineAwarenessStore.name);

  constructor(
    @InjectDataSource(DB_CONNECTION)
    private readonly ds: DataSource,
  ) {}

  /**
   * Durably append a milestone to a thread's buffer — idempotent: a marker whose `id` is already queued
   * is dropped (the same thread group fires repeatedly). Runs under a row lock so it can't lose a concurrent
   * drain's clear or another append. A missing thread is a no-op.
   */
  async appendMarker(jobId: string, marker: PipelineMarker): Promise<void> {
    await this.ds.transaction(async (m) => {
      const rows: Array<{ a: unknown }> = await m.query(
        `SELECT pipeline_awareness AS a FROM jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      if (rows.length === 0) return;
      const a = normalize(rows[0].a);
      if (a.markerQueue.some((x) => x.id === marker.id)) return; // already queued — idempotent
      a.markerQueue.push(marker);
      await m.query(`UPDATE jobs SET pipeline_awareness = $2 WHERE id = $1`, [
        jobId,
        JSON.stringify(a),
      ]);
    });
  }

  /**
   * Atomically DRAIN the milestone buffer and ADVANCE the state watermark for one turn. In a single locked
   * transaction: read the queued markers, clear them, and — if `currentSig` differs from the last conveyed
   * signature — advance the watermark (so the net-state summary is conveyed exactly once per change).
   * Returns the drained markers + whether the net state changed (the caller renders the prefix). A missing
   * thread (or one not yet in the build lifecycle, `currentSig === null`) drains nothing.
   */
  async drainAndAdvance(
    jobId: string,
    currentSig: string | null,
  ): Promise<{ markers: PipelineMarker[]; stateChanged: boolean }> {
    return this.ds.transaction(async (m) => {
      const rows: Array<{ a: unknown }> = await m.query(
        `SELECT pipeline_awareness AS a FROM jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      if (rows.length === 0) return { markers: [], stateChanged: false };
      const a = normalize(rows[0].a);
      const markers = a.markerQueue;
      const stateChanged =
        currentSig != null && currentSig !== a.conveyedStateSig;
      // Nothing to do — leave the row untouched (no needless write on an idle operator turn).
      if (markers.length === 0 && !stateChanged)
        return { markers: [], stateChanged: false };
      const next: ThreadPipelineAwareness = {
        markerQueue: [],
        conveyedStateSig: stateChanged ? currentSig : a.conveyedStateSig,
      };
      await m.query(`UPDATE jobs SET pipeline_awareness = $2 WHERE id = $1`, [
        jobId,
        JSON.stringify(next),
      ]);
      return { markers, stateChanged };
    });
  }
}

/** Coerce a raw jsonb value (possibly null/legacy-shaped) into a well-formed awareness buffer. */
function normalize(raw: unknown): ThreadPipelineAwareness {
  const a = (
    raw && typeof raw === 'object' ? raw : {}
  ) as Partial<ThreadPipelineAwareness>;
  return {
    markerQueue: Array.isArray(a.markerQueue) ? a.markerQueue : [],
    conveyedStateSig:
      typeof a.conveyedStateSig === 'string' ? a.conveyedStateSig : null,
  };
}
