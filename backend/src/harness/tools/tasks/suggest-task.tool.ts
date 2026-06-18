import { z } from 'zod';
import { recallProjects } from '../../domain/identity';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { SuggestionService } from '../../approvals/suggestion.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * The orchestrator's PROACTIVE work-proposal tool — the in-harness twin of desktop Claude Code's
 * `spawn_task` chip. Atlas surfaces a piece of work he's spotted as a clickable chip with Run / Keep
 * in backlog / Dismiss buttons; Dennis filters it in one click. It captures the item on the backlog
 * (so the work is never lost even if the chip can't post) AND posts the chip. Lead-only, with the
 * belt-and-braces authority check here (the proposal/board.tools idiom). Dispositions:
 *   • Run now  → Dennis greenlights it; Atlas is woken to pick it up (scope+dispatch, or bugfix).
 *   • Keep     → it stays on the backlog as a candidate.
 *   • Dismiss  → it's pruned off the backlog.
 */

const suggestSchema = z.object({
  title: z
    .string()
    .describe('Short imperative headline for the work, e.g. "Add a cancel-flow save offer".'),
  why: z
    .string()
    .describe(
      "Why it's worth doing — the rationale Dennis weighs before deciding. Shown on the chip.",
    ),
  description: z
    .string()
    .optional()
    .describe('Optional extra detail / scope beyond the why.'),
  suggested_disposition: z
    .enum(['run', 'backlog'])
    .optional()
    .describe(
      "Your non-binding recommendation — 'run' if it's worth doing now, 'backlog' to park it. A hint on the chip; Dennis still picks.",
    ),
  project: z
    .string()
    .optional()
    .describe("Which project's backlog; omit for the current room's project."),
});

@HarnessTool()
export class SuggestTaskTool implements IHarnessTool<typeof suggestSchema> {
  readonly name = 'suggest_task';
  readonly description =
    "Surface a piece of work you've spotted to Dennis as a clickable CHIP — a low-friction 'here's something worth doing' with Run now / Keep in backlog / Dismiss buttons. Use it to PROACTIVELY propose follow-up work (your own findings, an out-of-scope discovery) without committing him: it parks the item on the backlog and lets him pick the disposition in one click. Run now greenlights it and hands it back to you to dispatch; Keep leaves it as a backlog candidate; Dismiss prunes it. For work he's ALREADY greenlit, dispatch it; for something you just want on the backlog silently with no chip, use enqueue_finding.";
  readonly schema = suggestSchema;

  constructor(
    private readonly employees: EmployeeRegistry,
    private readonly suggestions: SuggestionService,
  ) {}

  async execute(
    {
      title,
      why,
      description,
      suggested_disposition,
      project,
    }: z.infer<typeof suggestSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    if (!this.employees.byId(id.selfAgent)?.teamLead)
      return `Suggesting tasks to Dennis is the team lead's call.`;
    const named = project?.trim().toLowerCase();
    const target =
      named && recallProjects(id).includes(named) ? named : id.project;

    const r = await this.suggestions.suggest({
      team: id.team,
      project: target,
      title,
      why,
      description,
      suggestedDisposition: suggested_disposition,
      proposedBy: id.selfAgent,
      surfaceId: id.surface,
    });
    if (!r.ok)
      return `Couldn't capture the suggestion on the ${target} backlog — try again.`;

    const base = `Suggested #${r.taskId} to Dennis: ${title}`;
    if (r.presented === 'posted')
      return `${base} — chip posted (Run now / Keep in backlog / Dismiss). It's parked on the ${target} backlog meanwhile; his pick comes back in the channel. No need to re-announce it.`;
    if (r.presented === 'no-surface')
      return `${base}. No chip surface is bound here — it's parked on the ${target} backlog (#${r.taskId}); walk Dennis through it in this channel and let him decide whether to run or drop it.`;
    // 'failed' — capture stood, the chip post threw.
    return `${base}, and it's parked on the ${target} backlog (#${r.taskId}), but posting the chip FAILED (${r.error}) — flag it to Dennis in this channel instead. Don't call suggest_task again for the same thing or you'll duplicate the board item.`;
  }
}
