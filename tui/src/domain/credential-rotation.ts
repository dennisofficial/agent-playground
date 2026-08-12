/**
 * Whether the credential sitting in the engine's home is a refresh worth keeping.
 *
 * Atlas writes a credentials file for the engine to read, and the engine writes back to it: when the
 * access token is close to expiry the CLI refreshes it itself, in place, and the server rotates the
 * refresh token as it does. Atlas used to never read that file back, so the pair in the database
 * became scrap the first time the engine beat it to a refresh — and the next refresh Atlas attempted
 * failed with a hard 4xx that marked the account dead.
 *
 * Structural token pairs rather than the SDK's credential blob: `domain/` cannot see `auth/`, and the
 * decision needs exactly two strings.
 */
export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. The only ordering there is between two pairs — see the `stale` decision. */
  expiresAt: number;
};

export type AdoptionDecision =
  /** Newer than what we hold, and ours. Persist it. */
  | 'adopt'
  /** The file still holds the pair we wrote. Nothing happened. */
  | 'unchanged'
  /** Another account's credential — one engine home is shared by every account of that engine. */
  | 'foreign'
  /** Older than what we hold. Adopting it would undo a refresh Atlas already made. */
  | 'stale'
  /** Missing or half-written. Never overwrite a working credential with blanks. */
  | 'unusable';

export function decideAdoption(args: {
  observed: TokenPair;
  stored: TokenPair;
  /** Every OTHER account's stored pair for the same engine. */
  others: readonly TokenPair[];
}): AdoptionDecision {
  const { observed, stored, others } = args;
  if (observed.accessToken.length === 0 || observed.refreshToken.length === 0)
    return 'unusable';

  if (
    observed.accessToken === stored.accessToken &&
    observed.refreshToken === stored.refreshToken
  )
    return 'unchanged';

  // A match on EITHER half names the owner: the access token rotates on every refresh, so the two
  // halves of a pair age differently and only one of them may still match the row it came from.
  const belongsToAnother = others.some(
    (other) =>
      other.accessToken === observed.accessToken ||
      other.refreshToken === observed.refreshToken,
  );
  if (belongsToAnother) return 'foreign';

  // The file is written FROM the database, so it normally runs level with it or ahead. It falls
  // behind in one window: Atlas refreshes out of band — the usage poll does — and the next turn dies
  // before writing the file. Adopting then would restore the pair Atlas has already replaced, whose
  // refresh token that rotation invalidated. A refresh only ever moves expiry forward.
  if (observed.expiresAt < stored.expiresAt) return 'stale';

  return 'adopt';
}
