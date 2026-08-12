import { EAccountStatus } from '../generated/prisma/enums.js';

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
 * The next account to run on, or `parked` when every account is spent.
 *
 * Unknown usage sorts LAST (`?? 101`, above any real percentage). Usage is polled per account, so a
 * null reading means "not measured recently", not "idle" — and rotating onto an unmeasured account
 * can land straight back on a wall. Known headroom first, unknown as the fallback.
 */
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

  const [next] = [...candidates].sort(
    (a, b) => (a.fiveHourUtil ?? 101) - (b.fiveHourUtil ?? 101),
  );

  if (!next) return { kind: 'parked', resumesAt: earliestReset(args.accounts) };
  return { kind: 'rotated', to: next };
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
