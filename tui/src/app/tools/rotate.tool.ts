import { z } from 'zod';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Hand this session over to a fresh one and keep working.

Your context window is finite and every turn re-sends the whole of it. When it is filling — or you
are about to start something that needs room — write your progress report here: this session closes,
the next one opens on the SAME thread with your report as its first message, and you carry on. The
thread, the files, the job and the cursor are untouched; only the window turns over.

Nothing summarises this for you and nothing is inherited. What you write in these four fields, plus
whatever you attach, is everything the next leg will know. Its transcript starts empty.

Atlas does not compact. Rotating is how context is reclaimed, and it is cheap — reach for it early
rather than working a full window down to the last few thousand tokens.`;

const DONE = `What actually landed, and how you know it did.

Verification is the part that stops your successor redoing it: "slice 3's upload route is written and
\`bun test\` is green" is worth ten lines of narrative.`;

const TRIED_AND_REJECTED = `The dead ends, WITH the reason each one died.

This is the section that matters most and the one easiest to skip. Every hour you lost to an approach
that could not work is an hour your successor will lose in exactly the same way, because it cannot
see your transcript — the lesson survives here or nowhere. Write "nothing" only if you truly rejected
nothing.`;

const SURPRISES = `What this codebase did that the spec, the plan and the docs did not say.

The auth header the fetch wrapper adds; the test that only passes in band; the migration that must run
first. Facts a fresh reader would have to rediscover the hard way. "Nothing" is a real answer.`;

const NEXT = `Where to pick up, concretely enough to act on without reading the transcript.

Name files, functions and the next command to run — not "continue the work".`;

const NOTES = `Anything outside the four sections that the next leg should know. Optional, and an
escape hatch rather than a place to repeat yourself.`;

const ATTACH = `Files from the job's context folder to inline into the next session's first message,
named as \`specs/03-slice.md\` or \`charting/map.md\`. Inlined in full, so it reads them without a
truncating Read.

Optional here, unlike the thread and phase seams: this is the same thread, and the phase's shared
files come with you either way. Name what the NEXT leg has to have in front of it.`;

/**
 * `rotate` — the session seam, and the only Atlas verb a teammate holds.
 *
 * Four typed fields rather than one prose argument, because the schema is the only thing railing the
 * agent and this is the highest-stakes payload on the map: asked for a "handoff", a model under
 * context pressure writes a summary of what it did, and "tried and rejected" — the section no other
 * harness has, and the one that stops the successor re-running the predecessor's worst hour — is the
 * first thing it drops. Named fields cannot be silently dropped.
 *
 * Ungated: rotation is universal. Every thread in every phase can fill a window, and a session with
 * no way to hand over can only be cut, which is the thing this design exists to avoid.
 */
export function rotateTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const shape = {
    // All four required, and `.min(1)` on each: an empty string is how a required field becomes an
    // optional one in practice. "nothing" costs a word and is a real answer, which the descriptions
    // say explicitly.
    done: z.string().min(1).describe(DONE),
    tried_and_rejected: z.string().min(1).describe(TRIED_AND_REJECTED),
    surprises: z.string().min(1).describe(SURPRISES),
    next: z.string().min(1).describe(NEXT),
    notes: z.string().optional().describe(NOTES),
    attach: z.array(z.string()).optional().describe(ATTACH),
  };

  return {
    name: EAtlasTool.rotate,
    description: DESCRIPTION,
    // The one tool on the teammate tier. A teammate never moves Atlas's structure — no phase, no
    // thread, no cursor — but it runs a session of its own, and a session that cannot rotate can
    // only die of a full window.
    tiers: [EToolTier.thread, EToolTier.teammate],
    shape,
    handler: async (raw) => {
      const parsed = z.object(shape).parse(raw);
      return args.actions.rotate({
        ctx: args.ctx,
        sections: {
          done: parsed.done,
          triedAndRejected: parsed.tried_and_rejected,
          surprises: parsed.surprises,
          next: parsed.next,
          ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
        },
        attach: parsed.attach ?? [],
      });
    },
  };
}
