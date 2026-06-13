import { Injectable } from '@nestjs/common';
import { Identity, recallProjects } from '../domain/identity';
import type { EmployeeDefinition } from '../employees/employee.types';
import { BoardStore } from './board-store';
import { SemanticMemory } from './semantic-memory';
import { SessionNoteStore } from './session-note.store';
import type { SessionNote } from './session-note.store';
import { TaskStore } from './task-store';

// Cap on reminders injected per turn so a growing plate doesn't monotonically bloat context.
const REMINDER_CAP = 12;
// Cap on active board tasks shown in the working-state slot.
const BOARD_TASK_CAP = 5;
// Cap on open session notes shown in the notes slot.
const NOTES_CAP = 10;

/** Priority order for note kinds: blockers surface first, then todos, hypotheses, handoffs. */
const NOTE_KIND_ORDER: Record<string, number> = {
  blocker: 0,
  todo: 1,
  hypothesis: 2,
  handoff: 3,
};

const sortNotes = (a: SessionNote, b: SessionNote): number =>
  (NOTE_KIND_ORDER[a.kind] ?? 9) - (NOTE_KIND_ORDER[b.kind] ?? 9);

/**
 * The pre-LLM context ASSEMBLER — builds the `recalled` block injected before the bot thinks.
 * Priority policy (top = highest priority, smallest footprint; bottom = lower priority):
 *
 *   1. Standing context core (~100–200 tokens, always emitted):
 *        Role + active project + ≤5 team-scope standing preferences (no embedding — near-free).
 *   2. Active board tasks  (in_progress for this bot, hard-capped at BOARD_TASK_CAP).
 *   3. Reminder plate      (open tasks, REMINDER_CAP-capped).
 *   4. Open session notes  (per-thread scratchpad: blocker→todo→hypothesis→handoff, NOTES_CAP-capped).
 *   5. Compaction summary  (Phase 6 — empty-safe until Phase 6 lands).
 *   6. Memory suggestions  (Phase 2 — empty-safe until Phase 2 lands).
 *
 * The bulk semantic-recall ("What you already know") and cross-project blocks are REMOVED from
 * auto-injection — they live behind on-demand `recall_facts()` / `search_conversation_history()`.
 * Those blocks created a "Lost in the Middle" problem: marginally-relevant facts buried the ones
 * that actually matter. The tiny always-on core is what the bot can reliably use; everything else
 * is on-demand.
 *
 * The bot's worktrees + sessions (`workContext`) are assembled by the `recallNode` in
 * `bot-graph.nodes.ts` and joined to this output — they are bounded working state that lives in
 * the graph layer because they need WorktreeService + SessionRegistry.
 *
 * Split into `fetchMemory` (sections 1–2) and `fetchTasks` (section 3) so the post-tools
 * `refreshContext` node can recompute only the dirtied half without re-running the whole assembler.
 * `fetchContext` remains as a full-context convenience wrapper (backward-compat for callers and
 * tests that want the complete block in one call).
 */
@Injectable()
export class FetchService {
  constructor(
    private readonly semantic: SemanticMemory,
    private readonly tasks: TaskStore,
    private readonly board: BoardStore,
    private readonly sessionNotes: SessionNoteStore,
  ) {}

  /**
   * The standing-context + board-work slice of the pre-LLM context (`memory` refresh scope).
   * No query or embedding — cheap. Returns the standing context core (role, project, team prefs)
   * plus any in-progress board tasks, and (Phase 2) memory suggestions from the previous turn.
   *
   * `memorySuggestions` is the string written by `reconcileNode` at the END of the previous turn
   * (stored in `BotState.memorySuggestions`). Pass '' or omit to skip the suggestions slot.
   * This parameter is NOT re-passed on a mid-turn `refreshContext` refresh — the suggestions slot
   * is unchanged when a memory tool fires mid-turn (only the standing context/board facts change).
   *
   * This is the half refreshed when remember / update_memory / forget run mid-turn.
   */
  async fetchMemory(
    bot: EmployeeDefinition,
    id: Identity,
    memorySuggestions?: string,
  ): Promise<string> {
    const parts: string[] = [];

    // ── 1. Standing context core ────────────────────────────────────────────────────────────────
    // Role + active project is always rendered for grounding (it's nearly free and restates
    // identity compactly). Team-scope standing prefs are appended when present.
    const prefs = await this.semantic.standingContext(id).catch(() => '');
    const coreLines: string[] = [`Role: ${bot.role}, project: ${id.project}.`];
    if (prefs) coreLines.push(prefs);
    parts.push(`Standing context:\n${coreLines.join('\n')}`);

    // ── 2. Active board tasks (in_progress) ─────────────────────────────────────────────────────
    // Directly-actionable working state: what the bot is currently executing on the team board.
    const boardTasks = await this.board
      .list({ team: id.team, assignee: bot.id, status: 'in_progress' })
      .catch(() => []);
    if (boardTasks.length > 0) {
      const shown = boardTasks.slice(0, BOARD_TASK_CAP);
      const more = boardTasks.length - shown.length;
      const lines = shown.map((t) => `- [#${t.id}] ${t.title}`).join('\n');
      parts.push(
        `Active board work:\n${lines}${more > 0 ? `\n…and ${more} more (list_board)` : ''}`,
      );
    }

    // ── 4. Open session notes ─────────────────────────────────────────────────────────────────────
    // Thread-local scratchpad: blockers surface first (highest priority), then todos, hypotheses,
    // handoffs. Hard-capped at NOTES_CAP; omitted when empty. Scoped to (team, bot, surface).
    const openNotes = await this.sessionNotes
      .listOpen(id.team, bot.id, id.surface)
      .catch(() => []);
    if (openNotes.length > 0) {
      const sorted = [...openNotes].sort(sortNotes);
      const shown = sorted.slice(0, NOTES_CAP);
      const more = sorted.length - shown.length;
      const lines = shown
        .map((n) => `- [#${n.id}] (${n.kind}) ${n.body}`)
        .join('\n');
      parts.push(
        `Open notes (this thread):\n${lines}${more > 0 ? `\n…and ${more} more (list_session_notes)` : ''}`,
      );
    }

    // Slot 5 (compaction summary) is an empty-safe stub — wired in Phase 6.

    // ── 6. Memory suggestions (Phase 2) ─────────────────────────────────────────────────────────
    // Suggestions from the previous turn's read-only reconcile pass. The agent acts on them with
    // remember / update_memory / forget. Empty-safe: omitted when '' or undefined.
    if (memorySuggestions?.trim()) {
      parts.push(
        `Memory suggestions from last turn (act on these with remember / update_memory / forget if accurate):\n${memorySuggestions}`,
      );
    }

    return parts.join('\n\n');
  }

  /**
   * The reminders-plate slice of the pre-LLM context (`tasks` refresh scope). No query or
   * embedding — cheap. Returns '' when the plate is empty. The team lead sees the whole team's
   * plate; everyone else sees only their own.
   */
  async fetchTasks(bot: EmployeeDefinition, id: Identity): Promise<string> {
    // ── 3. Reminder plate ───────────────────────────────────────────────────────────────────────
    // Personal commitments the bot has made. A DM spans every project the pair shares.
    // Team-lead sees the whole team's plate; others see their own.
    const projects = recallProjects(id);
    const plates = await Promise.all(
      projects.map((project) =>
        (bot.teamLead
          ? this.tasks.openTasks(id.team, project)
          : this.tasks.listTasks({
              team: id.team,
              project,
              status: 'open',
              owner: bot.id,
            })
        ).catch(() => [] as Awaited<ReturnType<typeof this.tasks.listTasks>>),
      ),
    );
    const plate = plates.flat();
    if (plate.length === 0) return '';

    const shown = plate.slice(0, REMINDER_CAP);
    const more = plate.length - shown.length;
    const lines = shown
      .map(
        (t) =>
          `- [#${t.id}] ${t.description}${bot.teamLead ? ` (→ ${t.owner})` : ''}${projects.length > 1 ? ` [${t.project}]` : ''}`,
      )
      .join('\n');
    return `${bot.teamLead ? 'Open reminders (team)' : 'On your plate'}:\n${lines}${more > 0 ? `\n…and ${more} more` : ''}`;
  }

  /**
   * Build the full `recalled` context block for `bot` — `fetchMemory` + `fetchTasks` joined.
   * Returns '' when there's nothing to inject (an empty team store yields a role/project core +
   * nothing else — practically always non-empty). The caller MUST write the result into state
   * (even '') so a stale recall never survives the checkpoint.
   *
   * Kept for backward compatibility and as a convenience wrapper; the graph layer calls
   * `fetchMemory` and `fetchTasks` independently so `refreshContext` can recompute only the
   * dirtied slice.
   */
  async fetchContext(bot: EmployeeDefinition, id: Identity): Promise<string> {
    const [memory, tasks] = await Promise.all([
      this.fetchMemory(bot, id).catch(() => ''),
      this.fetchTasks(bot, id).catch(() => ''),
    ]);
    return [memory, tasks].filter((s) => s.trim()).join('\n\n');
  }
}
