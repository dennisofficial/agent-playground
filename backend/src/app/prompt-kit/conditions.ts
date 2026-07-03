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

/** The job is anything BUT onboarding (the normal planning/build brain). */
export const notOnboarding = (c: PromptCtx): boolean => c.jobKind !== 'onboarding';

/** Standing operator/org instructions are present (the conditional operator fragment). */
export const hasOrgInstructions = (c: PromptCtx): boolean =>
  !!c.settings?.userOrgInstructions && c.settings.userOrgInstructions.trim().length > 0;
