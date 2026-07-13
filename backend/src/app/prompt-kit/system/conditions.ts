/**
 * prompt-kit / conditions — reusable `@Fragment` gate predicates.
 *
 * The onboarding vs normal-brain split is a CONDITION on `ctx.jobKind`, not a separate agent: both are
 * `Agent.ATLAS_MAIN`. A fragment that belongs only to the normal brain gates `notOnboarding`; an
 * onboarding-only fragment gates `isOnboarding`; a fragment shared by both omits the gate.
 */
import type { JobKind } from '../../domain';
import type { PromptCtx } from './prompt-ctx';

/**
 * The job is of a specific build `kind` — the shared predicate for the per-`jobKind` orientation fragments
 * (the brain's job-kind switch and the worker's driver-framing block both gate on it).
 */
export const jobKindIs =
  (kind: JobKind) =>
  (c: PromptCtx): boolean =>
    c.jobKind === kind;

/** The job is an onboarding bring-up (the onboarding-persona fragments). */
export const isOnboarding = (c: PromptCtx): boolean => c.jobKind === 'onboarding';

/** The job reviews an existing external PR (the review-persona fragments). */
export const isReview = (c: PromptCtx): boolean => c.jobKind === 'review';

/** The job is NOT an external-PR review — build/onboarding authoring guidance may apply. */
export const notReview = (c: PromptCtx): boolean => c.jobKind !== 'review';

/**
 * Anything BUT onboarding — the shared non-onboarding surface (how to read harness tags, investigate,
 * sandbox basics, safety, task list). BOTH the normal build brain AND a review job compose these.
 */
export const notOnboarding = (c: PromptCtx): boolean => c.jobKind !== 'onboarding';

/**
 * The NORMAL planning/build brain — everything that grills, locks decisions, plans, and ships a build.
 * Excludes BOTH onboarding (its own bring-up persona) AND review (which reviews an existing PR and never
 * builds). Fragments that teach the build ceremony gate on this, not `notOnboarding`, so a review job
 * isn't handed 50k chars of plan/ship instructions it's told to ignore.
 */
export const isBuildBrain = (c: PromptCtx): boolean =>
  c.jobKind !== 'onboarding' && c.jobKind !== 'review';

/** Standing operator/org instructions are present (the conditional operator fragment). */
export const hasOrgInstructions = (c: PromptCtx): boolean =>
  !!c.settings?.userOrgInstructions && c.settings.userOrgInstructions.trim().length > 0;

/** Per-job auto-approve is ON (any mode but 'off') — inject the autonomous-mode fragment. */
export const hasAutoApprove = (c: PromptCtx): boolean => (c.settings?.autoApproveMode ?? 'off') !== 'off';

/** Per-job auto-merge is ON — inject the auto-merge fragment. */
export const hasAutoMerge = (c: PromptCtx): boolean => c.settings?.autoMerge === true;

/** The repo has an attached house-style profile (the conditional conventions fragment). */
export const hasRepoConventions = (c: PromptCtx): boolean =>
  !!c.settings?.repoConventions && c.settings.repoConventions.body.trim().length > 0;

/** This job runs on the Atlas repo itself (slug === ATLAS_REPO_SLUG) — gates the atlas-prod host-tool fragment. */
export const isAtlasRepo = (c: PromptCtx): boolean => c.job?.isAtlasRepo === true;
