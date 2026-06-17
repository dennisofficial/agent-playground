import { PipelineRunSection as PipelineRunSectionEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type SectionStatus =
  | 'pending'
  | 'planning'
  | 'building'
  | 'done'
  | 'failed';

/** One build phase parsed from a section's approved plan (the fenced `phases` JSON block). */
export interface SectionPhase {
  /** Phase number from the plan (1-based). */
  id: number;
  title?: string;
  /** Set true once this phase's post-phase review has completed — keeps boot-recovery from
   * re-running a review whose phase session was already idle. */
  reviewed?: boolean;
}

export interface PipelineRunSection {
  id: string;
  runId: string;
  team: string;
  /** Gap-numbered (10, 20, 30…) for insert-without-renumber; ORDER BY this for execution order. */
  ordinal: number;
  name: string;
  brief?: string;
  phaseRole: string;
  status: SectionStatus;
  /** The APPROVED plan (MD#2), archived at the section's gate (team_task_plans holds only the active). */
  planMd?: string;
  phases?: SectionPhase[];
  phaseCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelineRunSection {
  ordinal: number;
  name: string;
  brief?: string;
  phaseRole: string;
  status?: SectionStatus;
}

interface PipelineRunSectionRow {
  id: string;
  run_id: string;
  team_id: string;
  ordinal: number | string;
  name: string;
  brief: string | null;
  phase_role: string;
  status: string;
  plan_md: string | null;
  phases_json: SectionPhase[] | null;
  phase_count: number | string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toSection = (r: PipelineRunSectionRow): PipelineRunSection => ({
  id: r.id,
  runId: r.run_id,
  team: r.team_id,
  ordinal: Number(r.ordinal),
  name: r.name,
  brief: r.brief ?? undefined,
  phaseRole: r.phase_role,
  status: r.status as SectionStatus,
  planMd: r.plan_md ?? undefined,
  phases: r.phases_json ?? undefined,
  phaseCount: r.phase_count == null ? undefined : Number(r.phase_count),
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Durable store for the SECTIONS of a dynamic section-driver pipeline run. Atlas declares the section
 * list at dispatch; each section is planned just-in-time and built sequentially. The run's positional
 * `section_index` cursor selects the active section from `listForRun()` (ordinal-ordered); this table
 * is the durable archive (approved plan per section + parsed phases) the cursor advances over, so a
 * restart re-enters the right section and a prior section's plan survives the `team_task_plans`
 * overwrite. Raw-SQL, mirroring `PipelineRunStore`.
 */
export class PipelineRunSectionStore {
  constructor(private readonly repo: Repository<PipelineRunSectionEntity>) {}

  private async q(
    sql: string,
    params: unknown[],
  ): Promise<PipelineRunSectionRow[]> {
    return rawRows<PipelineRunSectionRow>(
      await this.repo.manager.query(sql, params),
    );
  }

  /** Insert the declared section list for a run (ordinal-ordered). */
  async createMany(
    runId: string,
    team: string,
    sections: ReadonlyArray<NewPipelineRunSection>,
  ): Promise<PipelineRunSection[]> {
    const out: PipelineRunSection[] = [];
    for (const s of sections) {
      const rows = await this.q(
        `INSERT INTO pipeline_run_sections
           (run_id, team_id, ordinal, name, brief, phase_role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
         RETURNING *`,
        [
          runId,
          team,
          s.ordinal,
          s.name,
          s.brief ?? null,
          s.phaseRole,
          s.status ?? 'pending',
        ],
      );
      out.push(toSection(rows[0]));
    }
    return out;
  }

  /** All sections of a run, in execution order (ordinal asc). */
  async listForRun(runId: string): Promise<PipelineRunSection[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_run_sections WHERE run_id = $1 ORDER BY ordinal ASC`,
      [runId],
    );
    return rows.map(toSection);
  }

  /** Guarded partial update — only fields present in patch are written; updated_at always set. */
  async update(
    id: string,
    patch: {
      status?: SectionStatus;
      planMd?: string | null;
      phases?: SectionPhase[] | null;
      phaseCount?: number | null;
    },
  ): Promise<PipelineRunSection | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if ('planMd' in patch) set('plan_md', patch.planMd ?? null);
    if ('phases' in patch) {
      args.push(patch.phases == null ? null : JSON.stringify(patch.phases));
      sets.push(`phases_json = $${args.length}::jsonb`);
    }
    if ('phaseCount' in patch) set('phase_count', patch.phaseCount ?? null);
    const rows = await this.q(
      `UPDATE pipeline_run_sections SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args,
    );
    return rows[0] ? toSection(rows[0]) : undefined;
  }
}
