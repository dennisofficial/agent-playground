/**
 * prompt-kit / conditions — reusable `@Fragment` gate predicates.
 *
 * The onboarding vs normal-brain split is a CONDITION on `ctx.jobKind`, not a separate agent: both are
 * `Agent.ATLAS_MAIN`. A fragment that belongs only to the normal brain gates `notOnboarding`; an
 * onboarding-only fragment gates `isOnboarding`; a fragment shared by both omits the gate.
 */
import type { PromptCtx } from './prompt-ctx';

/** The job is an onboarding bring-up (the onboarding-persona fragments). */
export const isOnboarding = (c: PromptCtx): boolean => c.jobKind === 'onboarding';

/** The job reviews an existing external PR (the review-persona fragments). */
export const isReview = (c: PromptCtx): boolean => c.jobKind === 'review';

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
