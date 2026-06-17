import { PipelinePhaseReview as PipelinePhaseReviewEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type PhaseReviewStatus = 'running' | 'done' | 'failed';

export interface PipelinePhaseReview {
  id: string;
  phaseId: string;
  runId: string;
  team: string;
  attempt: number;
  status: PhaseReviewStatus;
  engineSessionId?: string;
  blocker?: boolean;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelinePhaseReview {
  phaseId: string;
  attempt?: number;
  status?: PhaseReviewStatus;
  engineSessionId?: string;
}

interface PipelinePhaseReviewRow {
  id: string;
  phase_id: string;
  run_id: string;
  team_id: string;
  attempt: number | string;
  status: string;
  engine_session_id: string | null;
  blocker: boolean | null;
  summary: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toReview = (r: PipelinePhaseReviewRow): PipelinePhaseReview => ({
  id: r.id,
  phaseId: r.phase_id,
  runId: r.run_id,
  team: r.team_id,
  attempt: Number(r.attempt),
  status: r.status as PhaseReviewStatus,
  engineSessionId: r.engine_session_id ?? undefined,
  blocker: r.blocker == null ? undefined : r.blocker === true,
  summary: r.summary ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Durable store for per-phase REVIEW attempts — the read-only verdict sessions over built phases.
 * v1 is advisory; the row is the lineage Phase 5's multi-lens review + cross-section defect routing
 * build on. Raw-SQL, mirroring the other pipeline stores.
 */
export class PipelinePhaseReviewStore {
  constructor(private readonly repo: Repository<PipelinePhaseReviewEntity>) {}

  private async q(
    sql: string,
    params: unknown[],
  ): Promise<PipelinePhaseReviewRow[]> {
    return rawRows<PipelinePhaseReviewRow>(
      await this.repo.manager.query(sql, params),
    );
  }

  /** Open a new review attempt for a phase. */
  async create(
    runId: string,
    team: string,
    review: NewPipelinePhaseReview,
  ): Promise<PipelinePhaseReview> {
    const rows = await this.q(
      `INSERT INTO pipeline_phase_reviews
         (phase_id, run_id, team_id, attempt, status, engine_session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       RETURNING *`,
      [
        review.phaseId,
        runId,
        team,
        review.attempt ?? 1,
        review.status ?? 'running',
        review.engineSessionId ?? null,
      ],
    );
    return toReview(rows[0]);
  }

  /** All review attempts for a phase, oldest first. */
  async listForPhase(phaseId: string): Promise<PipelinePhaseReview[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_phase_reviews WHERE phase_id = $1 ORDER BY attempt ASC`,
      [phaseId],
    );
    return rows.map(toReview);
  }

  /** The latest review attempt for a phase, or undefined. */
  async latestForPhase(phaseId: string): Promise<PipelinePhaseReview | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_phase_reviews WHERE phase_id = $1 ORDER BY attempt DESC LIMIT 1`,
      [phaseId],
    );
    return rows[0] ? toReview(rows[0]) : undefined;
  }

  /** Drop ALL review rows for a section's phases — used when a section is reopened (the cross-section
   * design path). Reviews carry no `section_id`, so delete by the section's phase ids; run BEFORE the
   * phase rows are deleted so the subquery still resolves. Returns the number removed. */
  async deleteForSection(sectionId: string): Promise<number> {
    const rows = await this.q(
      `DELETE FROM pipeline_phase_reviews
         WHERE phase_id IN (SELECT id FROM pipeline_run_phases WHERE section_id = $1)
         RETURNING id`,
      [sectionId],
    );
    return rows.length;
  }

  /** Guarded partial update — only fields present in patch are written; updated_at always set. */
  async update(
    id: string,
    patch: {
      status?: PhaseReviewStatus;
      engineSessionId?: string | null;
      blocker?: boolean | null;
      summary?: string | null;
    },
  ): Promise<PipelinePhaseReview | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if ('engineSessionId' in patch)
      set('engine_session_id', patch.engineSessionId ?? null);
    if ('blocker' in patch) set('blocker', patch.blocker ?? null);
    if ('summary' in patch) set('summary', patch.summary ?? null);
    const rows = await this.q(
      `UPDATE pipeline_phase_reviews SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args,
    );
    return rows[0] ? toReview(rows[0]) : undefined;
  }
}
