import { Agent, ENGINEERING_STAGES } from '../agent';
import { hasRepoConventions, isBuildBrain } from '../conditions';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import type { PromptCtx } from '../prompt-ctx';

@FragmentGroup()
export class ConventionsGroup {
  @Fragment({
    usedBy: [
      Agent.PLANNING,
      Agent.POST_BUILD,
      Agent.CI,
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

  @Fragment({
    usedBy: ENGINEERING_STAGES,
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
