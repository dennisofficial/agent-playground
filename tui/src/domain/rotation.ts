import { EAccountStatus, type EEngine } from '../generated/prisma/enums.js';

/**
 * Rotate off an account once its 5-hour window is this full. Deliberately short of 100: the wall is
 * discovered by being refused mid-turn, and a turn refused halfway has already spent its input
 * tokens. Leaving headroom means the switch happens at a turn boundary, where it costs nothing but
 * a cold prompt cache.
 */
export const ROTATE_ABOVE = 95;

/**
 * The account facts rotation reads — structural, so `domain/` never imports the Prisma client. A
 * generated `Account` satisfies this by shape, which is the point: the decision can be tested with
 * object literals and no database.
 */
export type RotationCandidate = {
  id: string;
  status: EAccountStatus;
  fiveHourUtil: number | null;
  sevenDayUtil: number | null;
  fiveHourResetsAt: Date | null;
};

export type RotationChoice<T> =
  | { kind: 'rotated'; to: T }
  /** Nothing has headroom. `resumesAt` is what the UI counts down to. */
  | { kind: 'parked'; resumesAt: Date | null };

/**
 * The weekly window is checked at 100, not at `ROTATE_ABOVE`: it refills over days rather than
 * hours, so rotating early off a 96%-week account burns an account that still has real turns in it.
 * The 5-hour window is the one worth pre-empting.
 */
export function overThreshold(account: RotationCandidate): boolean {
  return (
    (account.fiveHourUtil ?? 0) >= ROTATE_ABOVE || (account.sevenDayUtil ?? 0) >= 100
  );
}

/**
 * A `limited` status is a wall the API already told us about; the thresholds are the wall we predict
 * from usage. Either one means: do not start another turn here.
 */
export function isWalled(account: RotationCandidate): boolean {
  return account.status === EAccountStatus.limited || overThreshold(account);
}

/**
 * Most headroom first. Unknown usage sorts LAST (`?? 101`, above any real percentage): usage is polled
 * per account, so a null reading means "not measured recently", not "idle" — and choosing an
 * unmeasured account over a measured one can land straight back on a wall.
 *
 * Shared by both choices below, which must agree about what "best" means or a rotation would land on
 * an account the opening choice would have passed over.
 */
function byHeadroom(a: RotationCandidate, b: RotationCandidate): number {
  return (a.fiveHourUtil ?? 101) - (b.fiveHourUtil ?? 101);
}

/** The next account to run on, or `parked` when every account is spent. */
export function chooseNext<T extends RotationCandidate>(args: {
  currentId: string;
  accounts: readonly T[];
}): RotationChoice<T> {
  const candidates = args.accounts.filter(
    (account) =>
      account.id !== args.currentId &&
      account.status === EAccountStatus.active &&
      !overThreshold(account),
  );

  const [next] = [...candidates].sort(byHeadroom);

  if (!next) return { kind: 'parked', resumesAt: earliestReset(args.accounts) };
  return { kind: 'rotated', to: next };
}

/**
 * Which account a NEW session runs on — the opening choice, not a rotation.
 *
 * Two tiers, and the second one is the whole reason this function exists. `expired` is not a fact
 * about a credential, it is the memory of ONE refresh that failed at some past moment — and the
 * commonest cause is the engine rotating the refresh token in its own home before Atlas got there.
 * Filtering `expired` out made that memory permanent: a live subscription that no code path would
 * ever try again, reported to the human as "no usable account". So actives first, by headroom, and an
 * expired account as the last resort — the refresh on the turn path either heals it or fails with
 * something a human can act on.
 *
 * `limited` and `revoked` are excluded on purpose. A limit is the API's own answer and belongs to
 * `chooseNext`; a revocation is not healed by trying.
 */
export function chooseForTurn<T extends RotationCandidate>(
  accounts: readonly T[],
): T | null {
  const inTier = (status: EAccountStatus): T[] =>
    accounts.filter((account) => account.status === status).sort(byHeadroom);

  return (
    inTier(EAccountStatus.active)[0] ?? inTier(EAccountStatus.expired)[0] ?? null
  );
}

/**
 * Why no account could be chosen, in the words the human needs — the other half of `chooseForTurn`
 * returning null, and here rather than in `app/` so it can be read as a table of three situations
 * instead of only through a constructed service.
 *
 * Each one is a different action for them, which is why the sentence is built rather than fixed: the
 * old single message ("no usable claude account") was true of all three and useful for none. `ctrl+a`
 * is named because it is global — the accounts page is one keypress from wherever they are standing.
 */
export function noAccountReason(args: {
  engine: EEngine;
  accounts: readonly RotationCandidate[];
  /** Injected so the sentence is testable — a fixed clock, and no `toLocaleTimeString` of "now". */
  formatTime?: (at: Date) => string;
}): string {
  const { engine, accounts } = args;
  if (accounts.length === 0)
    return `no ${engine} account yet — press ctrl+a to add one`;

  const limited = accounts.filter(
    (account) => account.status === EAccountStatus.limited,
  );
  if (limited.length === accounts.length) {
    const resumesAt = earliestReset(limited);
    const format = args.formatTime ?? defaultFormatTime;
    const when = resumesAt ? ` until ${format(resumesAt)}` : "";
    return `every ${engine} account is rate-limited${when} — press ctrl+a to add another`;
  }

  return `every ${engine} account needs re-authorising — press ctrl+a and add it again to replace the credential`;
}

function defaultFormatTime(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The soonest any account comes back. Accounts with no recorded reset contribute nothing rather than
 * `now` — an unknown reset is not an imminent one, and treating it as one would show a countdown
 * that expires into the same parked screen.
 */
export function earliestReset(accounts: readonly RotationCandidate[]): Date | null {
  const resets = accounts
    .map((account) => account.fiveHourResetsAt)
    .filter((date): date is Date => date instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  return resets[0] ?? null;
}
