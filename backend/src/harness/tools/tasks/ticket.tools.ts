import { z } from 'zod';
import { BoardStore } from '../../memory/board-store';
import { PlanStore } from '../../memory/plan-store';
import { TicketNoteStore } from '../../memory/ticket-note-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The lightweight-Jira ticket surface: a board task plus everything attached to it — per-employee
 * plans (with the lead's review state) and the append-only note trail. get_ticket is a drill-down
 * reader (overview snippets by default, full text by param, paged — the search_session idiom);
 * add_note parks durable context on the ticket, where chat scrollback can't lose it.
 */

const PLAN_SNIPPET = 500;
const NOTE_SNIPPET = 300;
const FULL_PAGE = 4000;
const NOTES_PAGE_SIZE = 10;

/** First `max` chars, cut at a line boundary where possible, with an ellipsis marker. */
function snippet(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const slice = text.slice(0, max);
  const nl = slice.lastIndexOf('\n');
  return { text: nl > max / 2 ? slice.slice(0, nl) : slice, cut: true };
}

/** One page of a long text: pages read TOP-DOWN (page 1 = the beginning — plans and notes are
 * documents, unlike transcripts). */
function paged(
  text: string,
  page: number,
  describeMore: (nextPage: number) => string,
): string {
  const pages = Math.max(1, Math.ceil(text.length / FULL_PAGE));
  const p = Math.min(Math.max(page, 1), pages);
  const body = text.slice((p - 1) * FULL_PAGE, p * FULL_PAGE);
  const footer =
    pages > 1
      ? `\n\n(page ${p}/${pages}${p < pages ? ` — ${describeMore(p + 1)}` : ''})`
      : '';
  return `${body}${footer}`;
}

const getTicketSchema = z.object({
  id: z.number().int().describe('The board task id (the #N from list_board).'),
  plan_of: z
    .string()
    .optional()
    .describe(
      "Read ONE employee's full attached plan (a roster id like 'alex') instead of the overview.",
    ),
  note: z
    .number()
    .int()
    .optional()
    .describe('Read one full note by its note id instead of the overview.'),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'For long plans/notes: which page of the full text (1 = the beginning). In the overview: which page of the note list (1 = newest).',
    ),
});

@HarnessTool()
export class GetTicketTool implements IHarnessTool<typeof getTicketSchema> {
  readonly name = 'get_ticket';
  readonly description =
    "Read a board ticket in full: description, every employee's attached plan (with the lead's review state), and its note trail. Default = an overview with snippets; drill into a full plan (plan_of) or a full note (note). The ticket is the durable record — check it before planning, reviewing, or picking work back up.";
  readonly schema = getTicketSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
    private readonly notes: TicketNoteStore,
  ) {}

  async execute(
    { id: taskId, plan_of, note, page }: z.infer<typeof getTicketSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const task = await this.board.get(id.team, taskId);
    if (!task) return `No board task #${taskId} found.`;

    if (plan_of !== undefined) {
      // One plan per ticket now — plan_of is vestigial; read the task's single attached plan.
      const plan = await this.plans.get(id.team, taskId);
      if (!plan)
        return `No plan on #${taskId} — get_ticket(${taskId}) lists what's attached.`;
      return `${plan.employee}'s plan on #${taskId} [lead: ${plan.leadStatus}] (updated ${plan.updatedAt}):\n\n${paged(
        plan.planMd,
        page ?? 1,
        (next) => `get_ticket(${taskId}, plan_of: '${plan.employee}', page: ${next})`,
      )}`;
    }

    if (note !== undefined) {
      const n = await this.notes.get(id.team, taskId, note);
      if (!n) return `No note #${note} on #${taskId}.`;
      return `Note #${n.id} on #${taskId} by ${n.author} (${n.createdAt}):\n\n${paged(
        n.body,
        page ?? 1,
        (next) => `get_ticket(${taskId}, note: ${note}, page: ${next})`,
      )}`;
    }

    // Overview: header + description + plan snippets + one page of note snippets.
    const deps = task.dependsOn.length
      ? `, after #${task.dependsOn.join(', #')}`
      : '';
    const header = `#${task.id} — ${task.title} (${task.assignee ? `→ ${task.assignee}` : 'unassigned'}, ${task.status}${deps}) [${task.project}]`;
    const description = task.description || '(no description)';

    const plans = await this.plans.listForTask(id.team, taskId);
    const planBlocks = plans.length
      ? plans
          .map((p) => {
            const s = snippet(p.planMd, PLAN_SNIPPET);
            const more = s.cut
              ? `\n…(${p.planMd.length} chars total — get_ticket(${taskId}, plan_of: '${p.employee}') for the full plan)`
              : '';
            return `### ${p.employee}'s plan [lead: ${p.leadStatus}] (updated ${p.updatedAt})\n${s.text}${more}`;
          })
          .join('\n\n')
      : '(no plans attached yet)';

    const { notes, total } = await this.notes.listForTask(id.team, taskId, {
      page: page ?? 1,
      pageSize: NOTES_PAGE_SIZE,
    });
    const notePages = Math.max(1, Math.ceil(total / NOTES_PAGE_SIZE));
    const noteLines = total
      ? notes
          .map((n) => {
            const s = snippet(n.body.replace(/\s+/g, ' '), NOTE_SNIPPET);
            const more = s.cut
              ? ` …(get_ticket(${taskId}, note: ${n.id}))`
              : '';
            return `- [note #${n.id}] ${n.author} (${n.createdAt}): ${s.text}${more}`;
          })
          .join('\n') +
        (notePages > 1
          ? `\n(notes page ${Math.min(page ?? 1, notePages)}/${notePages} of ${total}, newest first — get_ticket(${taskId}, page: N) for older)`
          : '')
      : '(no notes)';

    return `${header}\n\n${description}\n\n## Plans\n${planBlocks}\n\n## Notes\n${noteLines}`;
  }
}

const addNoteSchema = z.object({
  task_id: z
    .number()
    .int()
    .describe('The board task id (the #N from list_board).'),
  body: z
    .string()
    .describe(
      'The note, markdown — long content welcome (research write-ups, decisions, out-of-scope context). It lives on the ticket permanently.',
    ),
});

@HarnessTool()
export class AddNoteTool implements IHarnessTool<typeof addNoteSchema> {
  readonly name = 'add_note';
  readonly description =
    "Append a note to a board ticket — durable, unlike chat. Park out-of-scope discoveries (alongside backlogging them), research write-ups, and decisions on the ticket they belong to, so they're there when the work is planned at a later standup.";
  readonly schema = addNoteSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly notes: TicketNoteStore,
  ) {}

  async execute(
    { task_id, body }: z.infer<typeof addNoteSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const task = await this.board.get(id.team, task_id);
    if (!task) return `No board task #${task_id} found.`;
    const note = await this.notes.add(id.team, task_id, id.selfAgent, body);
    return `Note #${note.id} added to ticket #${task_id}.`;
  }
}
