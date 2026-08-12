import { describe, expect, it } from 'bun:test';
import {
  attentionFor,
  EAttentionCourt,
  EAttentionScope,
  EAttentionVerb,
  isLegal,
  NO_FACTS,
  statusCell,
  unionFacts,
  type AttentionFacts,
} from '../attention.js';

function facts(fields: Partial<AttentionFacts>): AttentionFacts {
  return { ...NO_FACTS, openThreadCount: 1, ...fields };
}

const job = EAttentionScope.job;
const thread = EAttentionScope.thread;

describe('attentionFor', () => {
  it('puts confirm above working — a turn resolves itself, a proposal never does', () => {
    const both = attentionFor({
      facts: facts({ turnRunning: true, proposalPending: true }),
      scope: job,
    });

    expect(both.verb).toBe(EAttentionVerb.confirm);
    expect(both.court).toBe(EAttentionCourt.yours);
  });

  it('hands a running turn to the agent’s court, with a spinner', () => {
    const attention = attentionFor({ facts: facts({ turnRunning: true }), scope: job });

    expect(attention.label).toBe('working…');
    expect(attention.court).toBe(EAttentionCourt.agent);
    expect(attention.spinner).toBe(true);
  });

  it('asks for a reply while anything is open and quiet', () => {
    expect(attentionFor({ facts: facts({}), scope: job }).label).toBe('reply');
  });

  it('asks a job with nothing open to start a phase', () => {
    const attention = attentionFor({ facts: facts({ openThreadCount: 0 }), scope: job });

    expect(attention.verb).toBe(EAttentionVerb.nothingOpen);
    expect(attention.label).toBe('start a phase');
    expect(attention.court).toBe(EAttentionCourt.yours);
  });

  it('calls the same fact on a thread closed, and puts it in nobody’s court', () => {
    const attention = attentionFor({ facts: facts({ openThreadCount: 0 }), scope: thread });

    expect(attention.verb).toBe(EAttentionVerb.nothingOpen);
    expect(attention.label).toBe('closed');
    expect(attention.court).toBe(EAttentionCourt.none);
  });

  it('reads a finished job with a PR as external rather than as yours', () => {
    const attention = attentionFor({
      facts: facts({ openThreadCount: 0, hasPullRequest: true }),
      scope: job,
    });

    expect(attention.label).toBe('shipped');
    expect(attention.court).toBe(EAttentionCourt.external);
  });

  it('keeps read state on its own channel — an unseen proposal is still a confirm', () => {
    const attention = attentionFor({
      facts: facts({ proposalPending: true, unseen: true }),
      scope: job,
    });

    expect(attention.label).toBe('confirm');
    expect(attention.unseen).toBe(true);
  });

  it('suppresses unread while a turn is running — text still arriving needs no go-read-this', () => {
    const attention = attentionFor({
      facts: facts({ turnRunning: true, unseen: true }),
      scope: job,
    });

    expect(attention.unseen).toBe(false);
  });

  it('never renders two situations you would act on differently as the same pixels', () => {
    const rendered = new Map<string, AttentionFacts>();
    const collisions: string[] = [];

    for (const combination of everyLegalCombination()) {
      const attention = attentionFor({ facts: combination, scope: job });
      const pixels = `${attention.unseen ? '●' : '·'} ${attention.court} ${attention.label}`;
      const seen = rendered.get(pixels);
      // Two facts may share pixels only when the differing fact changes nothing you would do: a
      // PR while threads are still open is not yet news, and unread is suppressed while working.
      if (seen && actionable(seen) !== actionable(combination)) collisions.push(pixels);
      rendered.set(pixels, combination);
    }

    expect(collisions).toEqual([]);
  });
});

/** What you would actually DO about a row — two facts that agree here may safely share pixels. */
function actionable(fact: AttentionFacts): string {
  if (fact.proposalPending) return 'press the key';
  if (fact.turnRunning) return 'wait';
  if (fact.openThreadCount === 0) return fact.hasPullRequest ? 'nothing' : 'start a phase';
  return fact.unseen ? 'read it' : 'reply';
}

function everyLegalCombination(): AttentionFacts[] {
  const out: AttentionFacts[] = [];
  for (const turnRunning of [false, true])
    for (const proposalPending of [false, true])
      for (const openThreadCount of [0, 1, 2])
        for (const unseen of [false, true])
          for (const hasPullRequest of [false, true]) {
            const combination = {
              turnRunning,
              proposalPending,
              openThreadCount,
              unseen,
              hasPullRequest,
            };
            if (isLegal(combination)) out.push(combination);
          }
  return out;
}

describe('unionFacts', () => {
  it('is a union, not a priority table — a job can be working and owe a confirm at once', () => {
    const rolled = unionFacts([
      facts({ proposalPending: true, unseen: true }),
      facts({ turnRunning: true }),
      facts({ openThreadCount: 0 }),
    ]);

    expect(rolled.turnRunning).toBe(true);
    expect(rolled.proposalPending).toBe(true);
    expect(rolled.unseen).toBe(true);
    // The confirm wins the word; the spinner is a separate channel and does not lose it.
    expect(attentionFor({ facts: rolled, scope: job }).label).toBe('confirm');
  });

  it('counts the threads that are open rather than summing their counts', () => {
    expect(unionFacts([facts({}), facts({}), facts({ openThreadCount: 0 })]).openThreadCount).toBe(2);
  });

  it('leaves a job with no threads at all in its opening state', () => {
    expect(unionFacts([])).toEqual(NO_FACTS);
  });
});

describe('statusCell', () => {
  it('puts the spinner in front of the verb, not in the dot’s place', () => {
    const attention = attentionFor({ facts: facts({ turnRunning: true }), scope: job });

    expect(statusCell({ attention, frame: '⠹' })).toBe('⠹ working…');
  });

  it('spends no columns on a spinner when nothing is running', () => {
    const attention = attentionFor({ facts: facts({ proposalPending: true }), scope: job });

    expect(statusCell({ attention, frame: '⠹' })).toBe('confirm');
  });
});

describe('isLegal', () => {
  it('refuses a running turn with nothing open', () => {
    expect(isLegal(facts({ turnRunning: true, openThreadCount: 0 }))).toBe(false);
  });

  it('refuses a proposal raised by no thread', () => {
    expect(isLegal(facts({ proposalPending: true, openThreadCount: 0 }))).toBe(false);
  });

  it('refuses a turn that is still running after proposing — proposing ends it', () => {
    expect(isLegal(facts({ turnRunning: true, proposalPending: true }))).toBe(false);
  });
});
