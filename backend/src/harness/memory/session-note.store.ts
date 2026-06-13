import { SessionNote as SessionNoteEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

/**
 * Thread-local structured notes — the bot's per-thread scratchpad. Scoped to
 * (team_id, owner_bot, channel_id) so a bot's notes for one thread are never visible in another.
 * Notes are session-local working memory, NOT global semantic facts (those live in SemanticMemory).
 *
 * Kinds: todo (concrete next step), hypothesis (assumption to track), blocker (stopping progress),
 * handoff (context a future bot/session needs). Resolved notes are soft-kept (status = 'resolved')
 * and drop out of the assembler's open-notes slot.
 */
export type NoteKind = 'todo' | 'hypothesis' | 'blocker' | 'handoff';
export type NoteStatus = 'open' | 'resolved';

export interface SessionNote {
  id: number;
  teamId: string;
  ownerBot: string;
  channelId: string;
  project: string;
  kind: NoteKind;
  body: string;
  status: NoteStatus;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: number | string;
  team_id: string;
  owner_bot: string;
  channel_id: string;
  project: string;
  kind: string;
  body: string;
  status: string;
  created_at: unknown;
  updated_at: unknown;
}

const toNote = (r: NoteRow): SessionNote => ({
  id: Number(r.id),
  teamId: r.team_id,
  ownerBot: r.owner_bot,
  channelId: r.channel_id,
  project: r.project,
  kind: r.kind as NoteKind,
  body: r.body,
  status: r.status as NoteStatus,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

export class SessionNoteStore {
  constructor(private readonly repo: Repository<SessionNoteEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<NoteRow[]> {
    return rawRows<NoteRow>(await this.repo.manager.query(sql, params));
  }

  /** Add a new note to the thread scratchpad. Returns the created note. */
  async add(
    team: string,
    ownerBot: string,
    channelId: string,
    project: string,
    kind: NoteKind,
    body: string,
  ): Promise<SessionNote> {
    const rows = await this.q(
      `INSERT INTO session_notes (team_id, owner_bot, channel_id, project, kind, body, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), now())
       RETURNING *`,
      [team, ownerBot, channelId, project, kind, body],
    );
    return toNote(rows[0]);
  }

  /**
   * Open notes for this bot's current thread, newest first.
   * Scoped strictly to (team, ownerBot, channelId) — different threads are isolated.
   */
  async listOpen(
    team: string,
    ownerBot: string,
    channelId: string,
  ): Promise<SessionNote[]> {
    const rows = await this.q(
      `SELECT * FROM session_notes
       WHERE team_id = $1 AND owner_bot = $2 AND channel_id = $3 AND status = 'open'
       ORDER BY created_at ASC`,
      [team, ownerBot, channelId],
    );
    return rows.map(toNote);
  }

  /**
   * Resolved notes for this bot's current thread, newest first.
   * Used by the list_session_notes tool when status='resolved' is requested.
   */
  async listResolved(
    team: string,
    ownerBot: string,
    channelId: string,
  ): Promise<SessionNote[]> {
    const rows = await this.q(
      `SELECT * FROM session_notes
       WHERE team_id = $1 AND owner_bot = $2 AND channel_id = $3 AND status = 'resolved'
       ORDER BY updated_at DESC`,
      [team, ownerBot, channelId],
    );
    return rows.map(toNote);
  }

  /**
   * Resolve a note by id. Returns true if it was found and resolved, false if unknown or already
   * resolved. Scoped to (team, ownerBot) so a bot can't resolve another bot's notes.
   */
  async resolve(id: number, team: string, ownerBot: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE session_notes
       SET status = 'resolved', updated_at = now()
       WHERE id = $1 AND team_id = $2 AND owner_bot = $3 AND status = 'open'
       RETURNING id`,
      [id, team, ownerBot],
    );
    return rows.length > 0;
  }
}
