import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { PlanStore } from '../../memory/plan-store';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

const submitPlanSchema = z.object({
  sessionId: z
    .string()
    .describe(
      'The planning session whose finished, self-reviewed plan to submit.',
    ),
});

/**
 * The employee's explicit gate on its own engine's plan — like pushing your Claude Code's plan after
 * you've read it. A board-linked plan turn RELAYS its (self-reviewed) plan to the employee instead of
 * auto-attaching; calling `submit_plan` is what attaches it to the ticket and wakes the lead. To
 * revise instead, reply_session with notes; to drop it, close_session. Non-terminal: announce + submit
 * in the same turn.
 */
@HarnessTool()
export class SubmitPlanTool implements IHarnessTool<typeof submitPlanSchema> {
  readonly name = 'submit_plan';
  readonly description =
    "Submit a planning session's finished plan to its board ticket — your explicit approval of your own plan. Attaches it (with its Q&A) to the linked ticket and notifies @Sam to review. Use ONLY after reading the relayed plan and being happy with it; to change it, reply_session with notes instead.";
  readonly schema = submitPlanSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly plans: PlanStore,
  ) {}

  async execute(
    { sessionId }: z.infer<typeof submitPlanSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.ownerBot !== ctx.identity.selfAgent)
      return `Couldn't submit ${sessionId}: not your session.`;
    if (session.status === 'running')
      return `${sessionId} is mid-turn — wait for it to report back before submitting.`;
    if (session.status === 'closed')
      return `${sessionId} is closed — nothing to submit.`;
    if (session.lastReportKind !== 'plan')
      return `${sessionId}'s last report isn't a plan — only a finished plan can be submitted (reply_session if it still needs work).`;
    if (session.boardTaskId === undefined)
      return `${sessionId} isn't linked to a board task — open it with board_task_id so its plan has a ticket to attach to.`;
    if (!session.lastReport) return `${sessionId} has no plan text to submit.`;

    await this.plans.attach({
      team: session.team,
      taskId: session.boardTaskId,
      employee: session.ownerBot,
      planMd: session.lastReport,
      sessionId,
    });
    return `Submitted your plan on #${session.boardTaskId} — it's attached to the ticket and @Sam is notified to review. Keep ${sessionId} open through the approval pipeline (Sam's review, then Dennis's verdict).`;
  }
}
