import { z } from 'zod';
import { AGENT_CONDITIONS } from '../../domain/thread-delegation.js';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Close this thread. Your work here is done and nothing succeeds you.

If a thread opened you, your \`resolution\` is delivered to it as a message and fires its next turn —
it has been waiting on exactly this, so write the resolution FOR that reader rather than as a status
report. If nothing opened you, Atlas hands the cursor to whichever thread in this phase is still
open, and your resolution stands as this thread's last word.

**Only legal while a sibling is still open.** Closing the last thread would leave the phase with
nobody in it, so this throws there — the exact inverse of \`advance_phase\`, which is legal only when
you ARE the last. Hand your work on with \`advance_thread\` or move the phase on instead.

You get no further turn in this thread either way. Stop the moment it returns.`;

const CONDITION = `How this thread ended — a closed thread has to say which of these it was.

\`resolved\`: the work you were opened for is done. \`out_of_scope\`: it turned out to sit past this
job's destination, so it is closed rather than resolved and your resolution says where the boundary
is. \`blocked\`: it cannot be finished from here, and your resolution says what has to happen first.`;

const RESOLUTION = `What you found, decided or produced — the whole of what leaves this thread.

Whoever reads it did not watch you work and your transcript is not theirs. Write it as prose
covering: the answer to the question you were opened for; what you TRIED AND REJECTED, with the
reason; anything durable you wrote to the context folder and where; and, where you are blocked or
out of scope, exactly what the boundary is.`;

/**
 * `complete_thread` is present in every phase and THROWS when it is not legal, where its siblings
 * are absent when they are not.
 *
 * The difference is that its legality moves under it: whether you are the last open thread is a
 * fact about the phase right now, and the tool list is resolved once when a thread opens. A schema
 * cannot rail a fact that changes mid-thread, so this is the one seam tool that refuses at call
 * time — and the refusal tells it which door to take instead, which is why a refusal is affordable
 * here and an absent tool would not be.
 */
export function completeThreadTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const [first, ...rest] = AGENT_CONDITIONS;
  const shape = {
    // Three of the six conditions. `handed_off`, `phase_advanced` and `abandoned` are Atlas's to
    // stamp — an agent must not be able to claim its work was carried on when it was not.
    condition: z.enum([first, ...rest]).describe(CONDITION),
    resolution: z.string().min(1).describe(RESOLUTION),
  };

  return {
    name: EAtlasTool.complete_thread,
    description: DESCRIPTION,
    // Threads only. A teammate never closes itself — it goes idle and its parent closes it.
    tiers: [EToolTier.thread],
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).parse(raw);
      return args.actions.completeThread({
        ctx: args.ctx,
        condition: parsed.condition,
        resolution: parsed.resolution,
      });
    },
  };
}
