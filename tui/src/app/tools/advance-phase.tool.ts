import { z } from 'zod';
import { exitsWithoutAsking } from '../../domain/phase-advance.js';
import { nextPhasesFor, phaseLabel } from '../../domain/phase-spec.js';
import { EAtlasTool, EToolTier, type ToolAudience } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const ASKS = `Propose that this phase is finished and that the job should move on.

**Nothing transitions when you call this.** It raises a proposal Dennis sees and confirms or
declines, and that may be hours from now — so end your turn the moment it returns. You get no
further turn in this thread either way: if he confirms, this thread closes; if he declines, he will
tell you why himself.

Only the LAST open thread in a phase may call it — while a sibling is still working the phase is not
finished, and this throws. Reach for \`advance_thread\` instead to hand your own work on.`;

const AUTO = `Finish this phase and move the job on.

This exit carries no decision, so it takes effect immediately: this thread closes, the phase you
name is created, and its first thread opens with your hand-off. Stop the moment it returns — you get
no further turn in this thread.

Only the LAST open thread in a phase may call it — while a sibling is still working the phase is not
finished, and this throws. Reach for \`advance_thread\` instead to hand your own work on.`;

const NEVER_RETURNS = `A phase never returns to the one that proposed it. There is no stack: what
crosses the boundary is your hand-off, your attachments, and whatever is durable in the context
folder. Nothing else comes with it.`;

const REASON = `Why this phase is done and why that one is next, in a sentence or two.

This is what DENNIS reads in the confirmation — not your successor. Say what was settled and what
the evidence for it is, in his words rather than in a status report's.`;

const HANDOFF = `Everything the next phase's first thread needs and cannot see. Its context is empty
apart from this and the files you attach — it did not watch you work, and your transcript is not its
transcript.

Write it as prose covering: what you did and where it stands; what you TRIED AND REJECTED, with the
reason; anything that surprised you about this codebase; and what you would do next.`;

const ATTACH = `Files from the job's context folder to inline into the next phase's first message,
named as \`specs/03-slice.md\` or \`charting/map.md\`. They are inlined in full, so it reads them
without a truncating Read.

Required, and \`[]\` is a real answer meaning "nothing situational" — the files the phase you are
entering shares with every thread are attached for you either way.`;

/**
 * A phase with nowhere to propose is offered no advance at all rather than an advance that refuses.
 * `ci` is that phase: its `next` is empty, which means *nothing to propose* and never *nothing is
 * legal* — re-entry after a red build is Dennis starting a phase, and this graph never railed him.
 */
const offeredHere = (audience: ToolAudience): boolean =>
  nextPhasesFor(audience.phase).length > 0;

/**
 * `advance_phase : phase :: advance_thread : thread` — both are *close me, create the next one,
 * carry a hand-off*. The difference is who confirms, and it is the whole of this ticket: a phase
 * boundary is a human boundary.
 *
 * The description is built per phase because the two behaviours are genuinely different from where
 * the agent sits. Telling a builder that Dennis will confirm, when `build` exits on its own, would
 * be a lie about what its next turn is — and there is no next turn to correct it in.
 */
export function advancePhaseTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const [first, ...rest] = nextPhasesFor(args.ctx.phase);
  // The same fact as `offeredHere`, evaluated earlier because it must be: zod cannot express an
  // enum with no members, so a phase proposing nothing cannot produce a tool to hide.
  if (!first) return null;

  const shape = {
    // The enum is `PhaseSpec.next` rather than every phase kind, because the schema is the only
    // thing railing the agent — `planning → ci` should be unemittable, not rejected after the fact.
    // It rails the AGENT only: a human-facing menu built off this list would strand a job, since
    // `ci` proposes nothing and yet must be leavable.
    kind: z
      .enum([first, ...rest])
      .describe(`Where the job goes next. You are in ${phaseLabel(args.ctx.phase)}.`),
    reason: z.string().min(1).describe(REASON),
    handoff: z.string().min(1).describe(HANDOFF),
    attach: z.array(z.string()).describe(ATTACH),
  };

  return {
    name: EAtlasTool.advance_phase,
    description: `${exitsWithoutAsking(args.ctx.phase) ? AUTO : ASKS}\n\n${NEVER_RETURNS}`,
    // Threads only. A teammate is owned by a thread and never moves Atlas's structure.
    tiers: [EToolTier.thread],
    offeredIn: offeredHere,
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).parse(raw);
      return args.actions.advancePhase({
        ctx: args.ctx,
        kind: parsed.kind,
        reason: parsed.reason,
        handoff: parsed.handoff,
        attach: parsed.attach,
      });
    },
  };
}
