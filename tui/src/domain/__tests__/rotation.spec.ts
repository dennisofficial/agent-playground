import { describe, expect, it } from 'bun:test';
import { EAccountStatus, EEngine } from '../../generated/prisma/enums.js';
import {
  ROTATE_ABOVE,
  chooseForTurn,
  chooseNext,
  earliestReset,
  isWalled,
  noAccountReason,
  overThreshold,
  type RotationCandidate,
} from '../rotation.js';

function account(over: Partial<RotationCandidate> & { id: string }): RotationCandidate {
  return {
    status: EAccountStatus.active,
    fiveHourUtil: null,
    sevenDayUtil: null,
    fiveHourResetsAt: null,
    ...over,
  };
}

describe('overThreshold', () => {
  it('walls the 5-hour window early, before the API refuses a turn mid-flight', () => {
    expect(overThreshold(account({ id: 'a', fiveHourUtil: ROTATE_ABOVE - 1 }))).toBe(false);
    expect(overThreshold(account({ id: 'a', fiveHourUtil: ROTATE_ABOVE }))).toBe(true);
  });

  it('walls the weekly window only when actually spent — it refills over days, not hours', () => {
    expect(overThreshold(account({ id: 'a', sevenDayUtil: 99 }))).toBe(false);
    expect(overThreshold(account({ id: 'a', sevenDayUtil: 100 }))).toBe(true);
  });

  it('treats an unmeasured account as having room, so a fresh account is usable', () => {
    expect(overThreshold(account({ id: 'a' }))).toBe(false);
  });
});

describe('isWalled', () => {
  it('believes a reported limit even when usage looks fine', () => {
    expect(isWalled(account({ id: 'a', status: EAccountStatus.limited, fiveHourUtil: 2 }))).toBe(
      true,
    );
  });

  it('does not wall an expired account — that is a re-auth, not a rotation', () => {
    expect(isWalled(account({ id: 'a', status: EAccountStatus.expired }))).toBe(false);
  });
});

describe('chooseNext', () => {
  it('never returns the account it was asked to leave', () => {
    const accounts = [account({ id: 'current', fiveHourUtil: 99 })];
    expect(chooseNext({ currentId: 'current', accounts })).toEqual({
      kind: 'parked',
      resumesAt: null,
    });
  });

  it('takes the most headroom available', () => {
    const accounts = [
      account({ id: 'current', fiveHourUtil: 99 }),
      account({ id: 'busy', fiveHourUtil: 80 }),
      account({ id: 'idle', fiveHourUtil: 10 }),
    ];
    const choice = chooseNext({ currentId: 'current', accounts });
    expect(choice).toEqual({ kind: 'rotated', to: accounts[2]! });
  });

  it('prefers a measured account over an unmeasured one — unknown is not idle', () => {
    const accounts = [
      account({ id: 'current', fiveHourUtil: 99 }),
      account({ id: 'unknown' }),
      account({ id: 'measured', fiveHourUtil: 40 }),
    ];
    const choice = chooseNext({ currentId: 'current', accounts });
    expect(choice).toEqual({ kind: 'rotated', to: accounts[2]! });
  });

  it('falls back to an unmeasured account when nothing measured has room', () => {
    const accounts = [
      account({ id: 'current', fiveHourUtil: 99 }),
      account({ id: 'unknown' }),
      account({ id: 'spent', fiveHourUtil: 97 }),
    ];
    const choice = chooseNext({ currentId: 'current', accounts });
    expect(choice).toEqual({ kind: 'rotated', to: accounts[1]! });
  });

  it('skips accounts that are not active, whatever their usage says', () => {
    const accounts = [
      account({ id: 'current', fiveHourUtil: 99 }),
      account({ id: 'expired', status: EAccountStatus.expired, fiveHourUtil: 0 }),
      account({ id: 'revoked', status: EAccountStatus.revoked, fiveHourUtil: 0 }),
      account({ id: 'limited', status: EAccountStatus.limited, fiveHourUtil: 0 }),
    ];
    expect(chooseNext({ currentId: 'current', accounts }).kind).toBe('parked');
  });

  it('parks with the soonest reset when every account is spent', () => {
    const soon = new Date('2026-01-01T10:00:00Z');
    const later = new Date('2026-01-01T12:00:00Z');
    const accounts = [
      account({ id: 'current', fiveHourUtil: 99, fiveHourResetsAt: later }),
      account({ id: 'other', fiveHourUtil: 100, fiveHourResetsAt: soon }),
    ];
    expect(chooseNext({ currentId: 'current', accounts })).toEqual({
      kind: 'parked',
      resumesAt: soon,
    });
  });

  it('does not mutate the caller’s list while sorting it', () => {
    const accounts = [
      account({ id: 'current', fiveHourUtil: 99 }),
      account({ id: 'b', fiveHourUtil: 80 }),
      account({ id: 'a', fiveHourUtil: 10 }),
    ];
    chooseNext({ currentId: 'current', accounts });
    expect(accounts.map((a) => a.id)).toEqual(['current', 'b', 'a']);
  });
});

/**
 * Opening a session is not rotating out of one: there is no account to leave, and refusing to run at
 * all is a worse answer than running on the only credential there is.
 */
describe('chooseForTurn', () => {
  it('takes the active account with the most headroom', () => {
    const accounts = [account({ id: 'busy', fiveHourUtil: 80 }), account({ id: 'idle', fiveHourUtil: 10 })];
    expect(chooseForTurn(accounts)).toEqual(accounts[1]!);
  });

  it('sorts an unmeasured account last among actives — unknown is not idle', () => {
    const accounts = [account({ id: 'unknown' }), account({ id: 'measured', fiveHourUtil: 90 })];
    expect(chooseForTurn(accounts)).toEqual(accounts[1]!);
  });

  /**
   * The point of the whole change. `expired` records that ONE refresh failed, at some past moment —
   * usually because the engine rotated the refresh token under us. Trying it costs one HTTP round
   * trip and either heals the account or fails with a message the human can act on; refusing to try
   * leaves a working subscription permanently unusable.
   */
  it('falls back to an expired account rather than refusing to run', () => {
    const accounts = [account({ id: 'dead', status: EAccountStatus.expired })];
    expect(chooseForTurn(accounts)?.id).toBe('dead');
  });

  it('prefers any active account over an expired one, however spent the active is', () => {
    const accounts = [
      account({ id: 'expired', status: EAccountStatus.expired, fiveHourUtil: 0 }),
      account({ id: 'active', fiveHourUtil: 99 }),
    ];
    expect(chooseForTurn(accounts)?.id).toBe('active');
  });

  it('never picks a limited account — the API has already refused it, and rotation owns that', () => {
    expect(chooseForTurn([account({ id: 'limited', status: EAccountStatus.limited })])).toBeNull();
  });

  it('never picks a revoked account — no request will heal it', () => {
    expect(chooseForTurn([account({ id: 'revoked', status: EAccountStatus.revoked })])).toBeNull();
  });

  it('is null when there is nothing at all', () => {
    expect(chooseForTurn([])).toBeNull();
  });

  it('does not mutate the caller’s list while sorting it', () => {
    const accounts = [account({ id: 'b', fiveHourUtil: 80 }), account({ id: 'a', fiveHourUtil: 10 })];
    chooseForTurn(accounts);
    expect(accounts.map((a) => a.id)).toEqual(['b', 'a']);
  });
});

/**
 * The sentence a human meets when a job will not start. One message ("no usable claude account") used
 * to cover all three situations, and each of them is a different thing for them to DO.
 */
describe('noAccountReason', () => {
  const engine = EEngine.claude;
  const at = (time: string): Date => new Date(`2026-01-01T${time}:00Z`);
  const formatTime = (date: Date): string => date.toISOString().slice(11, 16);

  it('sends someone with no account to the page that adds one', () => {
    expect(noAccountReason({ engine, accounts: [] })).toBe(
      'no claude account yet — press ctrl+a to add one',
    );
  });

  it('says rate-limited, and when it lifts, rather than naming the wrong problem', () => {
    const accounts = [
      account({ id: 'a', status: EAccountStatus.limited, fiveHourResetsAt: at('14:30') }),
    ];

    expect(noAccountReason({ engine, accounts, formatTime })).toBe(
      'every claude account is rate-limited until 14:30 — press ctrl+a to add another',
    );
  });

  it('quotes the SOONEST reset — that is the one worth waiting for', () => {
    const accounts = [
      account({ id: 'a', status: EAccountStatus.limited, fiveHourResetsAt: at('16:00') }),
      account({ id: 'b', status: EAccountStatus.limited, fiveHourResetsAt: at('14:30') }),
    ];

    expect(noAccountReason({ engine, accounts, formatTime })).toContain('until 14:30');
  });

  it('names no time when no reset was ever recorded, rather than inventing one', () => {
    const accounts = [account({ id: 'a', status: EAccountStatus.limited })];

    expect(noAccountReason({ engine, accounts, formatTime })).toBe(
      'every claude account is rate-limited — press ctrl+a to add another',
    );
  });

  it('asks for a re-authorisation when the credentials are the problem', () => {
    // `revoked` and `expired` both land here: whatever the status says, the human's move is to add the
    // account again, which replaces the credential in place.
    const accounts = [
      account({ id: 'a', status: EAccountStatus.expired }),
      account({ id: 'b', status: EAccountStatus.revoked }),
    ];

    expect(noAccountReason({ engine, accounts, formatTime })).toMatch(/needs re-authorising/);
  });

  it('does not claim a rate limit when only SOME accounts are limited', () => {
    // A mixed pool that chose nobody is a credential problem wearing a limit — saying "wait until
    // 14:30" would send them off to wait for something that will not fix it.
    const accounts = [
      account({ id: 'a', status: EAccountStatus.limited, fiveHourResetsAt: at('14:30') }),
      account({ id: 'b', status: EAccountStatus.revoked }),
    ];

    expect(noAccountReason({ engine, accounts, formatTime })).toMatch(/needs re-authorising/);
  });
});

describe('earliestReset', () => {
  it('is null when nothing has a recorded reset — an unknown reset is not an imminent one', () => {
    expect(earliestReset([account({ id: 'a' })])).toBeNull();
  });

  it('ignores the accounts with no reset rather than counting them as now', () => {
    const at = new Date('2026-01-01T10:00:00Z');
    expect(earliestReset([account({ id: 'a' }), account({ id: 'b', fiveHourResetsAt: at })])).toEqual(
      at,
    );
  });
});
