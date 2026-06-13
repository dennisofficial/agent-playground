import { SessionNote as SessionNoteEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';

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

const entityToNote = (e: SessionNoteEntity): SessionNote => ({
  id: e.id,
  teamId: e.team_id,
  ownerBot: e.owner_bot,
  channelId: e.channel_id,
  project: e.project,
  kind: e.kind as NoteKind,
  body: e.body,
  status: e.status as NoteStatus,
  createdAt: e.created_at.toISOString(),
  updatedAt: e.updated_at.toISOString(),
});

export class SessionNoteStore {
  constructor(private readonly repo: Repository<SessionNoteEntity>) {}

  /** Add a new note to the thread scratchpad. Returns the created note. */
  async add(
    team: string,
    ownerBot: string,
    channelId: string,
    project: string,
    kind: NoteKind,
    body: string,
  ): Promise<SessionNote> {
    const entity = await this.repo.save(
      this.repo.create({
        team_id: team,
        owner_bot: ownerBot,
        channel_id: channelId,
        project,
        kind,
        body,
        status: 'open',
      }),
    );
    return entityToNote(entity);
  }

  /**
   * Open notes for this bot's current thread, oldest first (creation order).
   * Scoped strictly to (team, ownerBot, channelId) — different threads are isolated.
   */
  async listOpen(
    team: string,
    ownerBot: string,
    channelId: string,
  ): Promise<SessionNote[]> {
    const rows = await this.repo.find({
      where: { team_id: team, owner_bot: ownerBot, channel_id: channelId, status: 'open' },
      order: { created_at: 'ASC' },
    });
    return rows.map(entityToNote);
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
    const rows = await this.repo.find({
      where: { team_id: team, owner_bot: ownerBot, channel_id: channelId, status: 'resolved' },
      order: { updated_at: 'DESC' },
    });
    return rows.map(entityToNote);
  }

  /**
   * Resolve a note by id. Returns true if it was found and resolved, false if unknown or already
   * resolved. Scoped to (team, ownerBot) so a bot can't resolve another bot's notes.
   */
  async resolve(id: number, team: string, ownerBot: string): Promise<boolean> {
    const note = await this.repo.findOne({
      where: { id, team_id: team, owner_bot: ownerBot, status: 'open' },
    });
    if (!note) return false;
    note.status = 'resolved';
    await this.repo.save(note);
    return true;
  }
}
