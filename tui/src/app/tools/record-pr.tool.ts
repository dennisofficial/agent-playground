import { z } from 'zod';
import { EAtlasTool, EToolTier, type ToolAudience } from '../../domain/tool-surface.js';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Tell Atlas which pull request this job has, once you have opened or found one.

**This does not ship anything.** Rebasing, pushing and opening the pull request are yours to do with
git and \`gh\`, in whatever way the situation actually calls for — Atlas has no opinion about it and
takes no action of its own. This call is bookkeeping: the number goes on the job so the jobs list can
show it and so a later phase knows a pull request already exists.

Safe to call again with the same URL — re-recording is a no-op and says so. Call it after every ship,
not only the one that opened the pull request, so a job whose PR was opened by hand picks it up.`;

const URL_DESCRIPTION = `The pull request's URL — \`https://github.com/owner/repo/pull/123\`.

The number is read out of it, so there is nothing else to pass. Pasting the whole of what
\`gh pr create\` printed is fine; the last line of it is taken.`;

/**
 * `record_pr` — offered in `ci` and nowhere else.
 *
 * The gate is surface economy and **not** a safeguard, which is worth stating plainly because its
 * predecessor's gate was sold as one. `ship_pr` was gated to `ci` on the argument that a builder
 * able to open a pull request mid-`build` would be shipping past the review the pipeline exists to
 * impose. That argument was always thin — `Bash` is in the native kit for every thread, so a builder
 * determined to run `gh pr create` was never one tool away from it — and now that this tool opens
 * nothing at all, it is gone entirely. What remains is that `ci` is where pull requests come from,
 * so `ci` is the only audience for whom this verb means anything.
 */
export function recordPrTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { pullRequest } = args.actions;
  if (!pullRequest) return null;

  const shape = { url: z.string().min(1).describe(URL_DESCRIPTION) };

  return {
    name: EAtlasTool.record_pr,
    description: DESCRIPTION,
    // Threads only. A teammate is owned by a thread and has no standing to say what the JOB shipped.
    tiers: [EToolTier.thread],
    offeredIn: (audience: ToolAudience) => audience.phase === EPhaseKind.ci,
    shape,
    handler: async (raw) => {
      // `parse`, not `safeParse`: a malformed call must not resolve as if something was recorded.
      const parsed = z.object(shape).parse(raw);
      return pullRequest.record({ ctx: args.ctx, url: parsed.url });
    },
  };
}
