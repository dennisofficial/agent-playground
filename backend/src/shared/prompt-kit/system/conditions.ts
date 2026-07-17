import type { JobKind } from '../../domain';
import type { PromptCtx } from './prompt-ctx';

export const jobKindIs =
  (kind: JobKind) =>
  (c: PromptCtx): boolean =>
    c.jobKind === kind;

export const isOnboarding = (c: PromptCtx): boolean => c.jobKind === 'onboarding';

export const isReview = (c: PromptCtx): boolean => c.jobKind === 'review';

export const notReview = (c: PromptCtx): boolean => c.jobKind !== 'review';

export const notOnboarding = (c: PromptCtx): boolean => c.jobKind !== 'onboarding';

export const isBuildBrain = (c: PromptCtx): boolean =>
  c.jobKind !== 'onboarding' && c.jobKind !== 'review';

export const hasOrgInstructions = (c: PromptCtx): boolean =>
  !!c.settings?.userOrgInstructions && c.settings.userOrgInstructions.trim().length > 0;

export const hasAutoApprove = (c: PromptCtx): boolean =>
  (c.settings?.autoApproveMode ?? 'off') !== 'off';

export const hasAutoMerge = (c: PromptCtx): boolean => c.settings?.autoMerge === true;

export const hasRepoConventions = (c: PromptCtx): boolean =>
  !!c.settings?.repoConventions && c.settings.repoConventions.body.trim().length > 0;

export const isAtlasRepo = (c: PromptCtx): boolean => c.job?.isAtlasRepo === true;
