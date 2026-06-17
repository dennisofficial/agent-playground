import { PipelineCodingSession as PipelineCodingSessionEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type CodingSessionStatus =
  | 'pending'
  | 'building'
  | 'reviewing'
  | 'done'
  | 'failed';

/** Coding-session statuses that mean "this group is the live one inside its building section". */
export const ACTIVE_CODING_STATUSES: CodingSessionStatus[] = ['building', 'reviewing'];

export interface PipelineCodingSession {
  id: string;
  sectionId: string;
  runId: string;
  team: string;
  ordinal: number;
  status: CodingSessionStatus;
  /** The harness Session id running this group's turns. */
  engineSessionId?: string;
  handoffIn?: string;
  handoffOut?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelineCodingSession {
  ordinal: number;
  status?: CodingSessionStatus;
  handoffIn?: string;
}

interface PipelineCodingSessionRow {
  id: string;
  section_id: string;
  run_id: string;
  team_id: string;
  ordinal: number | string;
  status: string;
  engine_session_id: string | null;
  handoff_in: string | null;
  handoff_out: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toCodingSession = (r: PipelineCodingSessionRow): PipelineCodingSession => ({
  id: r.id,
  sectionId: r.section_id,
  runId: r.run_id,
  team: r.team_id,
  ordinal: Number(r.ordinal),
  status: r.status as CodingSessionStatus,
  engineSessionId: r.engine_session_id ?? undefined,
  handoffIn: r.handoff_in ?? undefined,
  handoffOut: r.handoff_out ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Durable store for a section's CODING SESSIONS — the execution grouping of consecutive phases (1:1
 * with phases for now; Phase 4 folds contiguous phases into one). `engine_session_id` links the live
 * harness Session; `handoff_in`/`handoff_out` carry the inter-group handoff (Phase 4). Raw-SQL.
 */
export class PipelineCodingSessionStore {
  constructor(private readonly repo: Repository<PipelineCodingSessionEntity>) {}

  private async q(
    sql: string,
    params: unknown[],
  ): Promise<PipelineCodingSessionRow[]> {
    return rawRows<PipelineCodingSessionRow>(
      await this.repo.manager.query(sql, params),
    );
  }

  /** Materialize a section's coding-session rows (ordinal-ordered). */
  async createMany(
    runId: string,
    team: string,
    sectionId: string,
    sessions: ReadonlyArray<NewPipelineCodingSession>,
  ): Promise<PipelineCodingSession[]> {
    const out: PipelineCodingSession[] = [];
    for (const s of sessions) {
      const rows = await this.q(
        `INSERT INTO pipeline_coding_sessions
           (section_id, run_id, team_id, ordinal, status, handoff_in, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())
         RETURNING *`,
        [
          sectionId,
          runId,
          team,
          s.ordinal,
          s.status ?? 'pending',
          s.handoffIn ?? null,
        ],
      );
      out.push(toCodingSession(rows[0]));
    }
    return out;
  }

  /** All coding sessions of a section, in execution order (ordinal asc). */
  async listForSection(sectionId: string): Promise<PipelineCodingSession[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_coding_sessions WHERE section_id = $1 ORDER BY ordinal ASC`,
      [sectionId],
    );
    return rows.map(toCodingSession);
  }

  /** A single coding session by id, or undefined. */
  async get(id: string): Promise<PipelineCodingSession | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_coding_sessions WHERE id = $1`,
      [id],
    );
    return rows[0] ? toCodingSession(rows[0]) : undefined;
  }

  /** The live group of a section (status building/reviewing), lowest ordinal — the build cursor.
   * At most one per section by the sequential invariant. */
  async activeCodingSession(
    sectionId: string,
  ): Promise<PipelineCodingSession | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_coding_sessions
         WHERE section_id = $1 AND status = ANY($2)
         ORDER BY ordinal ASC LIMIT 1`,
      [sectionId, ACTIVE_CODING_STATUSES],
    );
    return rows[0] ? toCodingSession(rows[0]) : undefined;
  }

  /** The next group to build: lowest-ordinal `pending` group, or undefined when the section is done. */
  async nextPending(
    sectionId: string,
  ): Promise<PipelineCodingSession | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_coding_sessions
         WHERE section_id = $1 AND status = 'pending'
         ORDER BY ordinal ASC LIMIT 1`,
      [sectionId],
    );
    return rows[0] ? toCodingSession(rows[0]) : undefined;
  }

  /** Drop a section's still-`pending` groups (renegotiable grouping — the live/done groups are
   * immutable). Returns the number removed. Used to re-materialize the pending tail in one new shape. */
  async deletePending(sectionId: string): Promise<number> {
    const rows = await this.q(
      `DELETE FROM pipeline_coding_sessions
         WHERE section_id = $1 AND status = 'pending' RETURNING id`,
      [sectionId],
    );
    return rows.length;
  }

  /** Drop ALL coding-session rows of a section — used when a section is reopened (the cross-section
   * design path); the section re-plans + re-materializes its groups from scratch. Returns the number
   * removed. (Distinct from `deletePending`, which keeps the live/done groups for a regroup.) */
  async deleteForSection(sectionId: string): Promise<number> {
    const rows = await this.q(
      `DELETE FROM pipeline_coding_sessions WHERE section_id = $1 RETURNING id`,
      [sectionId],
    );
    return rows.length;
  }

  /** Guarded partial update — only fields present in patch are written; updated_at always set. */
  async update(
    id: string,
    patch: {
      status?: CodingSessionStatus;
      engineSessionId?: string | null;
      handoffIn?: string | null;
      handoffOut?: string | null;
    },
  ): Promise<PipelineCodingSession | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if ('engineSessionId' in patch)
      set('engine_session_id', patch.engineSessionId ?? null);
    if ('handoffIn' in patch) set('handoff_in', patch.handoffIn ?? null);
    if ('handoffOut' in patch) set('handoff_out', patch.handoffOut ?? null);
    const rows = await this.q(
      `UPDATE pipeline_coding_sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      args,
    );
    return rows[0] ? toCodingSession(rows[0]) : undefined;
  }
}
