import { TeamTaskNote as TeamTaskNoteEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

/**
 * Append-only notes on TEAM BOARD tasks — the lightweight-Jira comment trail. Durable parking for
 * out-of-scope discoveries, research write-ups (long markdown welcome), and approval verdicts.
 * Never updated, never deleted.
 */
export interface TicketNote {
  id: number;
  taskId: number;
  author: string;
  body: string;
  createdAt: string;
}

interface NoteRow {
  id: number | string;
  task_id: number | string;
  author: string;
  body: string;
  created_at: unknown;
}

const toNote = (r: NoteRow): TicketNote => ({
  id: Number(r.id),
  taskId: Number(r.task_id),
  author: r.author,
  body: r.body,
  createdAt: toIso(r.created_at),
});

const DEFAULT_PAGE_SIZE = 10;

export class TicketNoteStore {
  constructor(private readonly repo: Repository<TeamTaskNoteEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<NoteRow[]> {
    return rawRows<NoteRow>(await this.repo.manager.query(sql, params));
  }

  async add(
    team: string,
    taskId: number,
    author: string,
    body: string,
  ): Promise<TicketNote> {
    const rows = await this.q(
      `INSERT INTO team_task_notes (team_id, task_id, author, body, created_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING *`,
      [team, taskId, author, body],
    );
    return toNote(rows[0]);
  }

  /** One newest-first page plus the total count (for "page X of Y" rendering). */
  async listForTask(
    team: string,
    taskId: number,
    opts: { page?: number; pageSize?: number } = {},
  ): Promise<{ notes: TicketNote[]; total: number }> {
    const pageSize = Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE);
    const page = Math.max(1, opts.page ?? 1);
    const counted = await this.repo.manager.query(
      `SELECT COUNT(*)::int AS n FROM team_task_notes WHERE team_id = $1 AND task_id = $2`,
      [team, taskId],
    );
    const total = Number((rawRows<{ n: number }>(counted)[0] ?? { n: 0 }).n);
    const rows = await this.q(
      `SELECT * FROM team_task_notes WHERE team_id = $1 AND task_id = $2
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [team, taskId, pageSize, (page - 1) * pageSize],
    );
    return { notes: rows.map(toNote), total };
  }

  /** One full note by id, scoped to its task (so a typo'd id can't read across tickets). */
  async get(
    team: string,
    taskId: number,
    noteId: number,
  ): Promise<TicketNote | undefined> {
    const rows = await this.q(
      `SELECT * FROM team_task_notes WHERE team_id = $1 AND task_id = $2 AND id = $3`,
      [team, taskId, noteId],
    );
    return rows[0] ? toNote(rows[0]) : undefined;
  }
}
