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
 * The access token, not a decoded user.
 *
 * pgbase's `getPrincipal` is synchronous and atlas verifies tokens asynchronously, so the raw
 * credential is carried through as the principal and verified inside the claims builder, which may
 * be async. Nothing trusts this value until `AtlasClaimsBuilder.build` has verified the signature.
 */
export type AtlasPrincipal = string;
