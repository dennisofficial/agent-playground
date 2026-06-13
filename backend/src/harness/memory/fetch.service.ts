import { Injectable } from '@nestjs/common';
import { Identity, recallProjects } from '../domain/identity';
import type { EmployeeDefinition } from '../employees/employee.types';
import { BoardStore } from './board-store';
import { SemanticMemory } from './semantic-memory';
import { TaskStore } from './task-store';

// Cap on reminders injected per turn so a growing plate doesn't monotonically bloat context.
const REMINDER_CAP = 12;
// Cap on active board tasks shown in the working-state slot.
const BOARD_TASK_CAP = 5;

/**
 * The pre-LLM context ASSEMBLER — builds the `recalled` block injected before the bot thinks.
 * Priority policy (top = highest priority, smallest footprint; bottom = lower priority):
 *
 *   1. Standing context core (~100–200 tokens, always emitted):
 *        Role + active project + ≤5 team-scope standing preferences (no embedding — near-free).
 *   2. Active board tasks  (in_progress for this bot, hard-capped at BOARD_TASK_CAP).
 *   3. Reminder plate      (open tasks, REMINDER_CAP-capped).
 *   4. Open notes slot     (Phase 4 — empty-safe until Phase 4 lands).
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
 */
@Injectable()
export class FetchService {
  constructor(
    private readonly semantic: SemanticMemory,
    private readonly tasks: TaskStore,
    private readonly board: BoardStore,
  ) {}

  /**
   * Build the `recalled` context block for `bot`. Returns '' when there's nothing to inject (an
   * empty team store yields a role/project core + nothing else — practically always non-empty).
   * The caller MUST write the result into state (even '') so a stale recall never survives the
   * checkpoint.
   */
  async fetchContext(bot: EmployeeDefinition, id: Identity): Promise<string> {
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
    if (plate.length > 0) {
      const shown = plate.slice(0, REMINDER_CAP);
      const more = plate.length - shown.length;
      const lines = shown
        .map(
          (t) =>
            `- [#${t.id}] ${t.description}${bot.teamLead ? ` (→ ${t.owner})` : ''}${projects.length > 1 ? ` [${t.project}]` : ''}`,
        )
        .join('\n');
      parts.push(
        `${bot.teamLead ? 'Open reminders (team)' : 'On your plate'}:\n${lines}${more > 0 ? `\n…and ${more} more` : ''}`,
      );
    }

    // Slots 4–6 (session notes, compaction summary, memory suggestions) are empty-safe stubs
    // that will be wired in Phases 4, 6, and 2 respectively.

    return parts.join('\n\n');
  }
}
