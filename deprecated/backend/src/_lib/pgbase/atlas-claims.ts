/**
 * The resolved authorization context every policy predicate reads.
 *
 * `orgIds` is the member-level READ scope and `ownerOrgIds` the owner-level WRITE scope. pgbase
 * policies have a single predicate rather than one per action, so only `orgIds` appears in
 * policies.ts; the owner-level narrowing that `@Rls` used to apply to writes is enforced
 * imperatively by the command services, which is where pgbase's CQS split puts it.
 */
export interface AtlasClaims {
  readonly userId: string;
  readonly orgIds: readonly string[];
  readonly ownerOrgIds: readonly string[];
}

/**
 * The access token, not a decoded user — or `null` for an anonymous request.
 *
 * pgbase's `getPrincipal` is synchronous and atlas verifies tokens asynchronously, so the raw
 * credential is carried through as the principal and verified inside the claims builder, which may
 * be async. Nothing trusts this value until `AtlasClaimsBuilder.build` has verified the signature.
 *
 * `null` rather than a thrown error, because pgbase's context middleware runs on every route and
 * forwards a throw to `next(err)`. Throwing here would fail every unauthenticated request — login,
 * register, the GitHub App callback, the webhook endpoint — not just the ones that read data.
 * Anonymous instead resolves to claims with no orgs, so every RLS predicate matches nothing, which
 * is what the RLS layer this replaces did with EMPTY_CLAIMS.
 */
export type AtlasPrincipal = string | null;

/** No user, therefore no orgs, therefore no rows. */
export const ANONYMOUS_CLAIMS: AtlasClaims = { userId: '', orgIds: [], ownerOrgIds: [] };
