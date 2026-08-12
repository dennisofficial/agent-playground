import { z } from 'zod';
import { EAtlasTool, EToolTier, type ToolAudience } from '../../domain/tool-surface.js';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Put this work up as a pull request.

One call does all of it: rebase this branch onto the repository's default branch, push it, and open a
pull request if none is open yet. The base branch is read from GitHub as you go — nothing about it is
stored, so a repository that renamed its default branch is handled by asking again.

**Safe to call again.** If a pull request is already open for this branch, the push you just made
updated it and no second one is opened — so re-shipping after a fix is this same call, not a
different one.

Nothing watches the build afterwards. Atlas receives no webhooks and polls nothing, so do not wait
for a result and do not offer to: when the pull request exists, say what you shipped and close. If it
comes back red, Dennis starts a phase for it.`;

const TITLE = `The pull request title: one line, in the imperative, describing the change rather than
the job.

Ignored when a pull request is already open — that one keeps the title it has.`;

const BODY = `The pull request description, written for a reviewer reading it cold.

What changed, why, and how you verified it. They did not watch you work and have none of this
thread's context; the specs and the handoff are what this should be written from. Markdown.

Ignored when a pull request is already open — the commits you just pushed are the update.`;

/**
 * `ship_pr` — the `ci` phase's whole point, and offered nowhere else.
 *
 * Gated on the PHASE rather than on the role, and the `ship_pr` role existing does not change that.
 * `ci` is where shipping is the work — a builder that could open a pull request mid-`build` would be
 * shipping past the review the pipeline exists to put in front of it — while the ROLE exists so the
 * phase can declare what it opens with and so a webhook has something to route to later. Gating on
 * the role instead would take the tool away from the `ci` thread a human opens on a red build, which
 * is exactly the case idempotence was built for.
 */
export function shipPrTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { shipping } = args.actions;
  if (!shipping) return null;

  const shape = {
    title: z.string().min(1).describe(TITLE),
    body: z.string().min(1).describe(BODY),
  };

  return {
    name: EAtlasTool.ship_pr,
    description: DESCRIPTION,
    // Threads only. A teammate is owned by a thread; pushing a branch on its own behalf is exactly
    // the kind of outward-facing act the tier split exists to withhold.
    tiers: [EToolTier.thread],
    offeredIn: (audience: ToolAudience) => audience.phase === EPhaseKind.ci,
    shape,
    handler: async (raw) => {
      // `parse`, not `safeParse`: unlike the task list, a malformed ship must not resolve as if
      // something happened — the throw becomes an error result, which is the one shape a model does
      // not narrate as success.
      const parsed = z.object(shape).parse(raw);
      return shipping.ship({
        ctx: args.ctx,
        title: parsed.title,
        body: parsed.body,
      });
    },
  };
}
