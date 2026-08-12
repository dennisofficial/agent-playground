import { describe, expect, it } from 'bun:test';
import { EThreadRole } from '../../generated/prisma/enums.js';
import {
  audienceFor,
  budgetPercent,
  contextBand,
  decideNudge,
  EContextBand,
  ENudgeAudience,
  formatTokens,
  NUDGE_AUDIENCE,
  nudgeNotice,
  nudgeReason,
} from '../context-nudge.js';
import type { Budget } from '../usage.js';

const BUDGET: Budget = { soft: 180_000, hard: 300_000 };

describe('the bands', () => {
  it.each([
    [12_000, EContextBand.normal],
    [179_999, EContextBand.normal],
    [180_000, EContextBand.soft],
    [299_999, EContextBand.soft],
    [300_000, EContextBand.hard],
    [420_000, EContextBand.hard],
  ] as const)('%i tokens is %s', (tokens, expected) => {
    expect(contextBand({ tokens, budget: BUDGET })).toBe(expected);
  });
});

describe('the meter draws against the budget', () => {
  it('reads 100% exactly where the nudging starts', () => {
    expect(budgetPercent({ tokens: 180_000, budget: BUDGET })).toBe(100);
    expect(contextBand({ tokens: 180_000, budget: BUDGET })).toBe(EContextBand.soft);
  });

  it('goes past 100, because "27% over" is the reading worth acting on', () => {
    expect(budgetPercent({ tokens: 228_600, budget: BUDGET })).toBe(127);
    // The same session against a million-token window read 23% — green, on a meter that could not
    // warn before the quality was gone. That is the bug this replaces.
    expect(Math.round((228_600 / 1_000_000) * 100)).toBe(23);
  });
});

describe('the escalating cadence', () => {
  it('says nothing at all below the soft threshold', () => {
    expect(decideNudge({ tokens: 120_000, budget: BUDGET, turn: 4, last: null })).toBe(false);
  });

  it('fires once when the soft threshold is crossed', () => {
    expect(decideNudge({ tokens: 181_000, budget: BUDGET, turn: 4, last: null })).toBe(true);
  });

  it('never nudges twice in one turn, however many tools it calls', () => {
    // A forty-tool turn told forty times is the failure mode that makes a harness unusable, and the
    // agent has already been told once — the escalation is across turns.
    const last = { atTokens: 181_000, onTurn: 4 };
    expect(decideNudge({ tokens: 240_000, budget: BUDGET, turn: 4, last })).toBe(false);
  });

  it('waits 30K after the first, then tightens to 20K', () => {
    const first = { atTokens: 180_000, onTurn: 1 };
    expect(decideNudge({ tokens: 205_000, budget: BUDGET, turn: 2, last: first })).toBe(false);
    expect(decideNudge({ tokens: 210_000, budget: BUDGET, turn: 2, last: first })).toBe(true);

    const second = { atTokens: 210_000, onTurn: 2 };
    expect(decideNudge({ tokens: 225_000, budget: BUDGET, turn: 3, last: second })).toBe(false);
    expect(decideNudge({ tokens: 230_000, budget: BUDGET, turn: 3, last: second })).toBe(true);
  });

  it('nudges every turn past the hard threshold — and still does not cut', () => {
    const last = { atTokens: 300_000, onTurn: 9 };
    // One token later, on the next turn: insistent, and deliberately so. Nothing here ends a
    // session; the only forced rotation in Atlas is the API refusing the request.
    expect(decideNudge({ tokens: 300_001, budget: BUDGET, turn: 10, last })).toBe(true);
  });
});

describe('the audience follows the role', () => {
  it('tells the agent where the agent acts next', () => {
    expect(audienceFor(EThreadRole.builder)).toBe(ENudgeAudience.agent);
    expect(audienceFor(EThreadRole.master_review)).toBe(ENudgeAudience.agent);
  });

  it('tells the human where the conversation IS the artifact', () => {
    expect(audienceFor(EThreadRole.charting)).toBe(ENudgeAudience.human);
    expect(audienceFor(EThreadRole.planner)).toBe(ENudgeAudience.human);
    expect(audienceFor(EThreadRole.generic)).toBe(ENudgeAudience.human);
  });

  it('has an answer for every role, so a new one cannot inherit someone else’s', () => {
    for (const role of Object.values(EThreadRole)) {
      expect(NUDGE_AUDIENCE[role]).toBeDefined();
    }
  });
});

describe('what it says', () => {
  it('quotes the count and the budget, at the precision anyone reads', () => {
    expect(formatTokens(178_400)).toBe('178K');
    expect(formatTokens(1_240_000)).toBe('1.2M');
    expect(nudgeReason({ tokens: 178_400, budget: BUDGET })).toBe(
      'This session is at 178K of a 180K budget.',
    );
  });

  it('gets more insistent past the hard threshold, and still only asks', () => {
    const insistent = nudgeReason({ tokens: 310_000, budget: BUDGET });
    expect(insistent).toContain('310K of a 180K budget');
    expect(insistent).toContain('re-sends the whole transcript');
  });

  it('gives the human the verb rather than a paragraph', () => {
    expect(nudgeNotice({ tokens: 190_000, budget: BUDGET })).toBe(
      'context 190K of 180K · /rotate hands this thread to a fresh session',
    );
  });
});
