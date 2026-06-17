import { PipelineRunPhase as PipelineRunPhaseEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type PhaseStatus =
  | 'pending'
  | 'building'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'skipped';

/** Phase statuses that mean "this phase is the live one inside its building section". */
export const ACTIVE_PHASE_STATUSES: PhaseStatus[] = ['building', 'reviewing'];

export interface PipelineRunPhase {
  id: string;
  sectionId: string;
  runId: string;
  team: string;
  /** Gap-numbered execution order within the section. */
  ordinal: number;
  /** The stable phase id from the approved plan's `phases` block. */
  planPhaseId: number;
  title?: string;
  status: PhaseStatus;
  codingSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelineRunPhase {
  ordinal: number;
  planPhaseId: number;
  title?: string;
  status?: PhaseStatus;
  codingSessionId?: string;
}

interface PipelineRunPhaseRow {
  id: string;
  section_id: string;
  run_id: string;
  team_id: string;
  ordinal: number | string;
  plan_phase_id: number | string;
  title: string | null;
  status: string;
  coding_session_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toPhase = (r: PipelineRunPhaseRow): PipelineRunPhase => ({
  id: r.id,
  sectionId: r.section_id,
  runId: r.run_id,
  team: r.team_id,
  ordinal: Number(r.ordinal),
  planPhaseId: Number(r.plan_phase_id),
  title: r.title ?? undefined,
  status: r.status as PhaseStatus,
  codingSessionId: r.coding_session_id ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Durable store for a section's PHASES — explicit rows whose `status` is the build cursor (the
 * positional `phase_index` is dual-written through the transition; these rows are authoritative).
 * Raw-SQL, mirroring `PipelineRunSectionStore`.
 */
export class PipelineRunPhaseStore {
  constructor(private readonly repo: Repository<PipelineRunPhaseEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<PipelineRunPhaseRow[]> {
    return rawRows<PipelineRunPhaseRow>(await this.repo.manager.query(sql, params));
  }

  /** Materialize a section's phase rows (ordinal-ordered) from its approved plan. */
  async createMany(
    runId: string,
    team: string,
    sectionId: string,
    phases: ReadonlyArray<NewPipelineRunPhase>,
  ): Promise<PipelineRunPhase[]> {
    const out: PipelineRunPhase[] = [];
    for (const p of phases) {
      const rows = await this.q(
        `INSERT INTO pipeline_run_phases
           (section_id, run_id, team_id, ordinal, plan_phase_id, title, status, coding_session_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
         RETURNING *`,
        [
          sectionId,
          runId,
          team,
          p.ordinal,
          p.planPhaseId,
          p.title ?? null,
          p.status ?? 'pending',
          p.codingSessionId ?? null,
        ],
      );
      out.push(toPhase(rows[0]));
    }
    return out;
  }

  /** All phases of a section, in execution order (ordinal asc). */
  async listForSection(sectionId: string): Promise<PipelineRunPhase[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_phases WHERE section_id = $1 ORDER BY ordinal ASC`,
      [sectionId],
    );
    return rows.map(toPhase);
  }

  /** A single phase by id, or undefined. */
  async get(id: string): Promise<PipelineRunPhase | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_phases WHERE id = $1`,
      [id],
    );
    return rows[0] ? toPhase(rows[0]) : undefined;
  }

  /** The live phase of a section (status building/reviewing), lowest ordinal — at most one. */
  async activePhase(sectionId: string): Promise<PipelineRunPhase | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_phases
         WHERE section_id = $1 AND status = ANY($2)
         ORDER BY ordinal ASC LIMIT 1`,
      [sectionId, ACTIVE_PHASE_STATUSES],
    );
    return rows[0] ? toPhase(rows[0]) : undefined;
  }

  /** The next phase to build: lowest-ordinal `pending` phase, or undefined when the section is done. */
  async nextPending(sectionId: string): Promise<PipelineRunPhase | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_phases
         WHERE section_id = $1 AND status = 'pending'
         ORDER BY ordinal ASC LIMIT 1`,
      [sectionId],
    );
    return rows[0] ? toPhase(rows[0]) : undefined;
  }

  /** Drop ALL phase rows of a section — used when a section is reopened (the cross-section-defect
   * design path): the section re-plans from scratch, so its old phase rows must clear for the
   * re-approval to re-materialize them (the idempotency guard keys off `listForSection`). Returns the
   * number removed. */
  async deleteForSection(sectionId: string): Promise<number> {
    const rows = await this.q(
      `DELETE FROM pipeline_run_phases WHERE section_id = $1 RETURNING id`,
      [sectionId],
    );
    return rows.length;
  }

  /** Guarded partial update — only fields present in patch are written; updated_at always set. */
  async update(
    id: string,
    patch: { status?: PhaseStatus; codingSessionId?: string | null },
  ): Promise<PipelineRunPhase | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if ('codingSessionId' in patch)
      set('coding_session_id', patch.codingSessionId ?? null);
    const rows = await this.q(
      `UPDATE pipeline_run_phases SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args,
    );
    return rows[0] ? toPhase(rows[0]) : undefined;
  }
}
