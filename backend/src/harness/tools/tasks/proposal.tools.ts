import { z } from 'zod';
import { ProposalService } from '../../approvals/proposal.service';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { BoardStore } from '../../memory/board-store';
import { PlanStore } from '../../memory/plan-store';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The team lead's two approval-pipeline tools — layer 1 (reviewing each employee's attached plan)
 * and layer 2 (proposing the consolidated ticket to Dennis). Lead-only, with belt-and-braces
 * authority checks here (the board.tools.ts idiom).
 */

const approveSchema = z.object({
  task_id: z.number().int().describe('The board task (#N from list_board).'),
  employee: z
    .string()
    .describe(
      "Whose attached plan you're approving (a roster id like 'alex').",
    ),
});

@HarnessTool()
export class ApprovePlanTool implements IHarnessTool<typeof approveSchema> {
  readonly name = 'approve_plan';
  readonly description =
    "Record your LEAD sign-off on one employee's plan attached to a board task (your layer-1 review — read it with get_ticket first). A revised plan re-attaches as 'pending' and needs your approval again. Once EVERY plan on the ticket is lead-approved, consolidate and propose_plan it to Dennis.";
  readonly schema = approveSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    { task_id, employee }: z.infer<typeof approveSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    if (!this.employees.byId(id.selfAgent)?.teamLead)
      return `Reviewing plans is the team lead's call.`;
    const task = await this.board.get(id.team, task_id);
    if (!task) return `No board task #${task_id} found.`;
    const who = employee.trim().toLowerCase();
    const approved = await this.plans.approve(id.team, task_id, who);
    if (!approved)
      return `No plan by '${who}' is attached to #${task_id} — check get_ticket(${task_id}); plans attach automatically when a linked planning session finishes.`;
    const all = await this.plans.listForTask(id.team, task_id);
    const pending = all
      .filter((p) => p.leadStatus !== 'approved')
      .map((p) => p.employee);
    return pending.length
      ? `Approved ${who}'s plan on #${task_id} — tell ${who} to KEEP their planning session OPEN until Dennis rules (your sign-off clears layer 1 only; if Dennis sends revision notes, ${who} replies them into that still-open session). Still pending your review: ${pending.join(', ')}.`
      : `Approved ${who}'s plan on #${task_id} — tell ${who} to KEEP their planning session OPEN until Dennis rules (revision notes go back into it). All ${all.length} plan(s) on #${task_id} are now lead-approved: consolidate and propose_plan when ready.`;
  }
}

const proposeSchema = z.object({
  task_id: z.number().int().describe('The board task (#N from list_board).'),
  summary: z
    .string()
    .describe(
      "Your consolidated, first-person summary of the ticket's whole plan — what's being built, by whom, the contracts between the pieces, anything Dennis must weigh in on. This is what Dennis reads on the approval card (a few short paragraphs); the full per-employee plans ride along underneath it.",
    ),
});

@HarnessTool()
export class ProposePlanTool implements IHarnessTool<typeof proposeSchema> {
  readonly name = 'propose_plan';
  readonly description =
    "Propose a fully lead-approved ticket to Dennis: flips it to 'awaiting_approval' and (where the surface supports it) posts him an approval card — your summary, Approve/Request-changes/Deny buttons, the full plans threaded under it. His verdict comes back in the channel. Fire-and-forget: returns immediately; you can keep talking or propose the next ticket. Re-calling on an already-proposed ticket just re-posts the card.";
  readonly schema = proposeSchema;

  constructor(
    private readonly board: BoardStore,
    private readonly employees: EmployeeRegistry,
    private readonly proposals: ProposalService,
  ) {}

  async execute(
    { task_id, summary }: z.infer<typeof proposeSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    if (!this.employees.byId(id.selfAgent)?.teamLead)
      return `Proposing plans to Dennis is the team lead's call.`;
    // The guard ladder + CAS planning→awaiting_approval + the outbound card live in ProposalService
    // (shared with the Atlas pipeline runner); this tool maps the outcome to the lead's chat reply.
    const r = await this.proposals.propose({
      team: id.team,
      taskId: task_id,
      summary,
      proposedBy: id.selfAgent,
      surfaceId: id.surface,
    });
    if (!r.ok) {
      switch (r.kind) {
        case 'missing':
          return `No board task #${task_id} found.`;
        case 'bad-status':
          return `Board task #${task_id} is '${r.status}' — only planning work with finished plans can be proposed (or re-proposed while awaiting approval).`;
        case 'no-plans':
          return `No plans are attached to #${task_id} yet — employees attach plans by finishing a plan turn on a session linked to the ticket (board_task_id).`;
        case 'pending-approval':
          return `These plans on #${task_id} aren't lead-approved yet: ${r.pending.join(', ')} — review (get_ticket) and approve_plan each first.`;
        case 'cas-lost':
          return `Board task #${task_id} changed under you (now '${r.now ?? 'gone'}') — check list_board and retry if it still makes sense.`;
      }
    }
    const base = `Proposed #${task_id} to Dennis (awaiting_approval, ${r.planCount} plan(s))`;
    if (r.presented === 'no-surface')
      return `${base}. No approval-card surface is bound here — walk Dennis through your summary in this channel and record his verdict the usual way ('approved' only on his explicit word, quoting him).`;
    if (r.presented === 'failed')
      return `${base}, but posting the approval card FAILED (${r.error}) — walk Dennis through your summary in this channel instead, or retry propose_plan to re-post the card.`;
    return `${base} — approval card posted; his verdict will arrive in the channel. Give the team a one-line heads-up that #${task_id} is with Dennis.`;
  }
}
