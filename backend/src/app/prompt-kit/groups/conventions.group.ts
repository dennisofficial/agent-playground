/**
 * prompt-kit / groups / conventions — the REPO's opt-in house-style profile, injected build-facing.
 *
 * TOPIC bucket: per-repo convention customization. This is the repo-scoped sibling of `operator.group`
 * (org-scoped): a fixed Atlas-owned ENVELOPE wrapped around the profile `body` DATA resolved from
 * `repos.convention_profile_slug` (`ctx.settings.repoConventions`). CONDITIONAL on `hasRepoConventions`, so a
 * repo with no attached profile assembles byte-identical to today — a profile can never misfire on a repo
 * that doesn't follow the style. Ordered `9100` — after the operator band, so it reads as operator-layer
 * guidance, not Atlas-authoritative.
 *
 * `usedBy` is the full BUILD-FACING set across BOTH assembly layers: the planning brain (`ATLAS_MAIN`), the
 * host-assembled build/review/fix prompts (`WORKER`, `META_PLAN_REVIEW`, `AUTOFIX_REVIEW`, `AUTOFIX_FIX`),
 * AND the engine-assembled subagents (`FAN_OUT` writer, `REVIEW_AGENT`) — for which the resolved profile is
 * forwarded across the host→container wire (`RunEngineArgs.repoConventions`) and fed into `renderAgentPrompt`
 * inside the engine. Read-only advisory subagents (explore/docs/debug/test) are intentionally excluded.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { hasRepoConventions } from '../conditions';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class ConventionsGroup {
  /** The repo's attached house-style profile (only when a profile is attached to the repo). */
  @Fragment({
    usedBy: [
      Agent.ATLAS_MAIN,
      Agent.WORKER,
      Agent.FAN_OUT,
      Agent.REVIEW_AGENT,
      Agent.META_PLAN_REVIEW,
      Agent.AUTOFIX_REVIEW,
      Agent.AUTOFIX_FIX,
    ],
    order: 9100,
    condition: hasRepoConventions,
  })
  repoConventions(ctx: PromptCtx): string {
    const profile = ctx.settings?.repoConventions;
    if (!profile) return '';
    return [
      `REPO HOUSE CONVENTIONS ("${profile.name}") — operator-defined, for THIS repo.`,
      'Treat these as authoritative for how NEW code should be structured and styled, EXCEPT where the',
      'existing repo code already diverges — always match the code you actually see. These are conventions,',
      'not safety rules; if one conflicts with a safety rule above, surface the conflict.',
      '',
      profile.body.trim(),
    ].join('\n');
  }
}
