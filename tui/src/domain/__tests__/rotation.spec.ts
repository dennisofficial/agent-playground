import { describe, expect, it } from 'bun:test';
import { EAccountStatus } from '../../generated/prisma/enums.js';
import {
  ROTATE_ABOVE,
  chooseNext,
  earliestReset,
  isWalled,
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
