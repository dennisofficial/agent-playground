import { z } from 'zod';
import { rolesFor } from '../../domain/phase-spec.js';
import { EAtlasTool, EToolTier, type ToolAudience } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Delegate a question you cannot answer from here, and stay open.

Opens a second thread in this phase with the brief you write, hands Dennis over to it, and leaves
YOU exactly as you are. Reach for it when you hit something that wants its own conversation — fog
that has to be cleared before you can plan, a design question Dennis has to answer, a piece of work
that deserves a fresh context window — and you still have work to do here afterwards.

**You get no answer in this turn.** When that thread closes, its report arrives here as a message
and fires your next turn, so end this one the moment this returns. That may be minutes or hours; it
is a real conversation with a human in it, not a query.

Use \`advance_thread\` instead when you are FINISHED and something else should carry on — that one
closes you. This one does not.`;

const BRIEF = `What the thread you are opening is for, and what you need back from it.

Its context is empty apart from this and the files you attach — it did not watch you work, and your
transcript is not its transcript. Write it as prose covering: the question in one sentence; what you
already know and what you have ruled out; why you cannot settle it from here; and what a good answer
looks like, since that answer is what comes back to you.`;

const ATTACH = `Files from the job's context folder to inline into the new thread's first message,
named as \`specs/03-slice.md\` or \`charting/map.md\`. They are inlined in full, so it reads them
without a truncating Read.

Required, and \`[]\` is a real answer meaning "nothing situational" — the phase's own shared files
are attached for you either way, so an empty array costs the new thread nothing.`;

/**
 * The gate, stated once: a phase that hosts no roles has no legal thread to open, so it is offered
 * no delegation at all rather than a delegation that refuses.
 */
const offeredHere = (audience: ToolAudience): boolean =>
  rolesFor(audience.phase).length > 0;

/**
 * `open_thread` is a DELEGATION and `advance_thread` is a SUCCESSION — the distinction this pair
 * exists to make. One thread carrying two meanings was the gap design 03 §5 found: a thread that
 * opens its successor and closes wants no answer, and a planner clearing fog requires one.
 *
 * The `role` enum is `PhaseSpec.roles`, the app's only role list, for `advance_thread`'s reason:
 * the schema is the rail, so `planning → builder` is unemittable rather than refused afterwards.
 */
export function openThreadTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const [first, ...rest] = rolesFor(args.ctx.phase);
  // The same fact as `offeredHere`, evaluated earlier because it must be: zod cannot express an
  // enum with no members, so a phase hosting nothing cannot produce a tool to hide.
  if (!first) return null;

  const shape = {
    role: z.enum([first, ...rest]).describe('What the thread you are opening is for.'),
    brief: z.string().min(1).describe(BRIEF),
    attach: z.array(z.string()).describe(ATTACH),
  };

  return {
    name: EAtlasTool.open_thread,
    description: DESCRIPTION,
    // Threads only. A teammate is owned by a thread and never moves Atlas's structure — it cannot
    // open a thread Dennis talks to, and it has no cursor to move.
    tiers: [EToolTier.thread],
    offeredIn: offeredHere,
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).parse(raw);
      return args.actions.openThread({
        ctx: args.ctx,
        role: parsed.role,
        brief: parsed.brief,
        attach: parsed.attach,
      });
    },
  };
}
