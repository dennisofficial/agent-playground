import { z } from 'zod';
import { agentRolesFor } from '../../domain/phase-spec.js';
import { EAtlasTool, EToolTier, type ToolAudience } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Finish here and hand this job's next piece of work to a fresh thread.

Closes THIS thread — you get no further turn in it — opens exactly one successor in the same phase,
seeds it with your hand-off and the tasks you hand on, and makes it the job's active thread. Reach
for it when the work you were opened for is done and what comes next wants a different role or a
clean context window.

This does not end the phase: \`advance_phase\` does that and it waits on the human. A thread boundary
is not a human boundary, so this one takes effect immediately.`;

const HANDOFF = `Everything your successor needs and cannot see. Its context is empty apart from this
and the files you attach — it did not watch you work, and your transcript is not its transcript.

Write it as prose covering: what you did and where it stands; what you TRIED AND REJECTED, with the
reason (this is the section that stops your successor repeating your dead ends); anything that
surprised you about this codebase; and what you would do next.

Do not re-type your checklist here — \`carry\` is how a task travels. Prose is for the things a
checklist cannot hold.`;

const CARRY = `Which of YOUR tasks the successor should inherit, by number: \`[3, 4]\`.

They are copied onto its list and renumbered from #1 in the order you name them, so they become
tasks it can actually \`task_update\` — nothing points back at this thread. Naming them in a
different order re-sequences what remains.

Only UNFINISHED tasks can travel. A completed one is history, and history belongs in the hand-off;
naming it is ignored rather than refused.

Required, and \`[]\` is a real answer meaning "none of my list is your list" — say that where the
successor's work is genuinely different from what remained on yours. Do not carry a task you have
decided should not be done; retire it with \`task_update\` instead, or simply leave it here. This is
a judgement only you can make: you have just written down where the work stands, and you are the
only one who knows which lines of your plan survived writing it.`;

const ATTACH = `Files from the job's context folder to inline into your successor's first message,
named as \`specs/03-slice.md\` or \`charting/map.md\`. They are inlined in full, so it reads them
without a truncating Read.

Required, and \`[]\` is a real answer meaning "nothing situational" — the phase's own shared files
are attached for you either way, so an empty array costs the successor nothing.`;

/**
 * The gate, stated once: a phase that hosts no roles has no legal successor to open, so it is
 * offered no advance at all rather than an advance that refuses.
 */
const offeredHere = (audience: ToolAudience): boolean =>
  agentRolesFor(audience.phase).length > 0;

/**
 * `advance_thread : thread :: advance_phase : phase` — both are *close me, create the next one,
 * carry a hand-off*. The difference is only who confirms: a phase boundary is a human boundary and
 * a thread boundary is not, so this one takes effect the moment it is called.
 *
 * The `role` enum is built from `agentRolesFor(phase)` rather than from `EThreadRole`, because the
 * schema is the only thing railing the agent: `planning → builder` should be unemittable, not
 * rejected after the fact. Human-only roles are filtered out of it — a successor is the work
 * carrying on, and `generic` is by definition not the work.
 */
export function advanceThreadTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const [first, ...rest] = agentRolesFor(args.ctx.phase);
  // The same fact as `offeredHere`, evaluated earlier because it must be: zod cannot express an
  // enum with no members, so a phase offering nothing cannot produce a tool to hide.
  if (!first) return null;

  const shape = {
    role: z.enum([first, ...rest]).describe('What the successor thread is for.'),
    handoff: z.string().min(1).describe(HANDOFF),
    attach: z.array(z.string()).describe(ATTACH),
    carry: z.array(z.number().int().positive()).describe(CARRY),
  };

  return {
    name: EAtlasTool.advance_thread,
    description: DESCRIPTION,
    // Threads only. A teammate is owned by a thread and never moves Atlas's structure — it cannot
    // close the thread that opened it, and it has no cursor to move.
    tiers: [EToolTier.thread],
    offeredIn: offeredHere,
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).parse(raw);
      return args.actions.advanceThread({
        ctx: args.ctx,
        role: parsed.role,
        handoff: parsed.handoff,
        attach: parsed.attach,
        carry: parsed.carry,
      });
    },
  };
}
