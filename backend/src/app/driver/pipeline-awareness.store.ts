import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import type { PipelineMarker, ThreadPipelineAwareness } from '../persistence/entities/job.entity';

@Injectable()
export class PipelineAwarenessStore {
  private readonly logger = new Logger(PipelineAwarenessStore.name);

  constructor(
    @InjectDataSource(DB_CONNECTION)
    private readonly ds: DataSource,
  ) {}

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
      const stateChanged = currentSig != null && currentSig !== a.conveyedStateSig;
      if (markers.length === 0 && !stateChanged) return { markers: [], stateChanged: false };
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

function normalize(raw: unknown): ThreadPipelineAwareness {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<ThreadPipelineAwareness>;
  return {
    markerQueue: Array.isArray(a.markerQueue) ? a.markerQueue : [],
    conveyedStateSig: typeof a.conveyedStateSig === 'string' ? a.conveyedStateSig : null,
  };
}
