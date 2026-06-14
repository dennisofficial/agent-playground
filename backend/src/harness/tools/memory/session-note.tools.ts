import { z } from 'zod';
import { SessionNoteStore } from '../../memory/session-note.store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * Thread-local structured notes — the bot's per-thread scratchpad. These are working notes for
 * the CURRENT conversation thread (channel or DM), scoped to this bot and this surface. They are
 * NOT global semantic memory (use `remember` for durable cross-session facts). Open notes surface
 * automatically in the context assembler; resolved notes drop out. Use them to track what you're
 * working on, what you're unsure of, what's blocking you, or what a future session needs to know.
 *
 * Note: the `add_note` tool name is taken by board-ticket notes; these are `add_session_note` /
 * `list_session_notes` / `resolve_session_note` to avoid collision.
 */

const addSchema = z.object({
  kind: z
    .enum(['todo', 'hypothesis', 'blocker', 'handoff'])
    .describe(
      "'todo' — a concrete next step; 'hypothesis' — an assumption worth tracking; 'blocker' — something stopping progress; 'handoff' — context a future session needs.",
    ),
  body: z
    .string()
    .describe(
      'The note content, stated plainly. Keep it short — one or two sentences is enough for a scratchpad entry.',
    ),
});

@HarnessTool()
export class AddSessionNoteTool implements IHarnessTool<typeof addSchema> {
  readonly name = 'add_session_note';
  readonly refreshesContext = ['memory'] as const;
  readonly description =
    "Add a structured note to your scratchpad for this thread — a todo (next step), hypothesis (assumption to track), blocker (something stopping you), or handoff (context a future session needs). Open notes surface in your context automatically so you don't lose track. Resolve them with resolve_session_note when done.";
  readonly schema = addSchema;

  constructor(private readonly notes: SessionNoteStore) {}

  async execute(
    { kind, body }: z.infer<typeof addSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const note = await this.notes.add(
      id.team,
      id.selfAgent,
      id.surface,
      id.project,
      kind,
      body,
    );
    return `Note #${note.id} added (${kind}).`;
  }
}

const listSchema = z.object({
  status: z
    .enum(['open', 'resolved'])
    .optional()
    .describe("Filter by status — 'open' (default) or 'resolved'."),
});

@HarnessTool()
export class ListSessionNotesTool implements IHarnessTool<typeof listSchema> {
  readonly name = 'list_session_notes';
  readonly description =
    'List your structured notes for this thread. Defaults to open notes (blockers → todos → hypotheses → handoffs). Open notes also surface automatically in your context — use this tool to see resolved ones or to get a quick overview.';
  readonly schema = listSchema;

  constructor(private readonly notes: SessionNoteStore) {}

  async execute(
    { status }: z.infer<typeof listSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    // Only list_open is implemented on the store; for 'resolved' we run a direct query via
    // listOpen equivalent filtered by 'resolved'. For simplicity, leverage the store's listOpen
    // for open status and fall back to a raw call for resolved.
    const filter = status ?? 'open';
    let noteList;
    if (filter === 'open') {
      noteList = await this.notes.listOpen(id.team, id.selfAgent, id.surface);
    } else {
      // Resolved notes: use the store's underlying repo via a second store method.
      // For now, resolved are not auto-surfaced; the tool gives access when explicitly asked.
      noteList = await this.notes.listResolved(
        id.team,
        id.selfAgent,
        id.surface,
      );
    }

    if (noteList.length === 0) return `No ${filter} notes for this thread.`;

    const KIND_ORDER: Record<string, number> = {
      blocker: 0,
      todo: 1,
      hypothesis: 2,
      handoff: 3,
    };
    const sorted = [...noteList].sort(
      (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
    );
    const lines = sorted
      .map((n) => `- [#${n.id}] (${n.kind}) ${n.body}`)
      .join('\n');
    return `${filter === 'open' ? 'Open' : 'Resolved'} notes for this thread:\n${lines}`;
  }
}

const resolveSchema = z.object({
  id: z
    .number()
    .int()
    .describe('The note id to resolve (the #N from list_session_notes).'),
});

@HarnessTool()
export class ResolveSessionNoteTool implements IHarnessTool<
  typeof resolveSchema
> {
  readonly name = 'resolve_session_note';
  readonly refreshesContext = ['memory'] as const;
  readonly description =
    'Mark a session note resolved — it drops out of your active context. Pass the note id (the #N from list_session_notes or the context block). Use when a todo is done, a blocker is cleared, or a handoff has been delivered.';
  readonly schema = resolveSchema;

  constructor(private readonly notes: SessionNoteStore) {}

  async execute(
    { id: noteId }: z.infer<typeof resolveSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const resolved = await this.notes.resolve(noteId, id.team, id.selfAgent);
    return resolved
      ? `Note #${noteId} resolved.`
      : `No open note #${noteId} found (already resolved, or not yours).`;
  }
}
