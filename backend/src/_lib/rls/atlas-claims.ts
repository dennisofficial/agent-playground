/**
 * Atlas's RLS claims — the resolved authorization context every `@Rls` policy reads.
 * Kept app-side (the `@workspace/nestjs-rls` package is generic over this shape).
 */
export interface AtlasClaims {
  /** The acting user, or null for unauthenticated / onboarding requests. */
  userId: string | null;
  /** Orgs the user is a member of (member-level read scope). */
  orgIds: string[];
  /** Orgs the user OWNS (owner-level write scope). */
  ownerOrgIds: string[];
}

export const EMPTY_CLAIMS: AtlasClaims = { userId: null, orgIds: [], ownerOrgIds: [] };

/** CLS store keys. The `@workspace/nestjs-rls` package never sees these — only our resolver does. */
export const CLS_USER = 'rls.user';
export const CLS_CLAIMS = 'rls.claims';
