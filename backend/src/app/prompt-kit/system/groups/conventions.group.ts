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
import { hasRepoConventions, isBuildBrain } from '../conditions';
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

  /**
   * The build brain's "notice the house style should evolve" affordance. Only the conversational planning brain
   * (`ATLAS_MAIN`) on a real build (`isBuildBrain`) with a profile attached (`hasRepoConventions`) gets it — a
   * worker/reviewer/onboarding turn does not. It closes the gap the operator flagged: the house style is a
   * REUSABLE, cross-repo org resource, so a build must never silently rewrite it, but it SHOULD flag when the
   * convention itself is stale — routed to the owner-gated `propose_convention_profile_change`.
   */
  @Fragment({
    usedBy: [Agent.ATLAS_MAIN],
    order: 9110,
    condition: (c: PromptCtx) => isBuildBrain(c) && hasRepoConventions(c),
  })
  noticeHouseStyleDrift(): string {
    return [
      'NOTICING THE HOUSE STYLE SHOULD CHANGE — the conventions above are a REUSABLE, org-level profile shared by',
      'every repo that opts into it, so they are NOT yours to rewrite mid-build. But if, while planning or',
      'building, you notice the CONVENTION ITSELF is wrong, outdated, or would be clearly better changed (not',
      "merely that THIS repo's code diverges — where you just follow the code), do not silently work around it and",
      'do not hand-edit repo code to force a different convention. Instead:',
      '  - A genuine HOUSE-STYLE change (it should apply to every repo on this profile) → call',
      '    propose_convention_profile_change({ slug, body, rationale }) — it posts an OWNER-approved proposal;',
      '    keep building to the CURRENT style until/unless the owner approves.',
      '  - A durable fact specific to THIS repo only → store it in repo memory via `remember`, NOT in the',
      '    shared profile.',
      'Be judicious: propose a profile change only for a real, cross-cutting improvement — do not nag on routine',
      'builds. When unsure whether it is house-style vs repo-specific, prefer repo memory.',
    ].join('\n');
  }
}
