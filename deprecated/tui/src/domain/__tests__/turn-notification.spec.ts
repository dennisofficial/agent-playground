import { describe, expect, it } from 'bun:test';
import {
  EAttentionScope,
  EAttentionVerb,
  attentionFor,
  NO_FACTS,
  type AttentionFacts,
} from '../attention.js';
import { finishedThreads, turnNotification } from '../turn-notification.js';

/**
 * When a finished turn is worth a desktop banner.
 *
 * The interesting property is what this file does NOT contain: a table of which states deserve a
 * notification. `attentionFor` already ranks the verbs and derives whose court the ball is in, and
 * that derivation IS the question a notification asks — so these tests drive the real thing rather
 * than a fixture, which is what would catch the two tables drifting apart.
 */

function attention(facts: Partial<AttentionFacts>) {
  return attentionFor({
    facts: { ...NO_FACTS, ...facts },
    scope: EAttentionScope.job,
  });
}

/** The ordinary case: one open thread, nothing running, nothing proposed. */
const WAITING = attention({ openThreadCount: 1 });

describe('finishedThreads', () => {
  it('reports the lanes that emptied, and nothing else', () => {
    expect(finishedThreads({ before: ['a', 'b'], now: ['b'] })).toEqual(['a']);
  });

  /**
   * A turn STARTING is not news. Only the moment an agent stops can leave the ball somewhere, and a
   * notification on arrival would fire every time the human himself pressed enter.
   */
  it('says nothing about lanes that appeared', () => {
    expect(finishedThreads({ before: ['a'], now: ['a', 'b'] })).toEqual([]);
  });

  it('reports several at once, because two threads can settle on the same tick', () => {
    expect(finishedThreads({ before: ['a', 'b', 'c'], now: ['b'] })).toEqual(['a', 'c']);
  });

  /**
   * The first reading of the app's life compares against an empty set. A turn already in flight at
   * startup must not read as one that just ended.
   */
  it('finds nothing on the first reading', () => {
    expect(finishedThreads({ before: [], now: ['a'] })).toEqual([]);
  });
});

describe('turnNotification', () => {
  it('names the job and says what it wants', () => {
    expect(
      turnNotification({ jobTitle: 'Password policy', attention: WAITING, onScreen: false }),
    ).toEqual({ title: 'Password policy', message: 'is waiting on you' });
  });

  /**
   * The one case where the screen beats the banner. The transcript is about to render the very
   * thing the notification would announce, and macOS would show it anyway — some terminals only
   * suppress banners when the window is unfocused, which is not the same question.
   */
  it('stays quiet about the thread you are watching', () => {
    expect(
      turnNotification({ jobTitle: 'Password policy', attention: WAITING, onScreen: true }),
    ).toBeNull();
  });

  /**
   * A proposal is the notification most worth having: it is the state that never resolves itself.
   * It reaches here even while another thread of the job is still working, because `attentionFor`
   * ranks `confirm` above `working…` — and that ordering is inherited, not restated.
   */
  it('fires for a pending proposal even with another thread still running', () => {
    const proposing = attention({ openThreadCount: 2, proposalPending: true, turnRunning: true });
    expect(proposing.verb).toBe(EAttentionVerb.confirm);
    expect(
      turnNotification({ jobTitle: 'Password policy', attention: proposing, onScreen: false }),
    ).toEqual({ title: 'Password policy', message: 'wants your confirmation' });
  });

  /**
   * One turn of several ending is not the job going quiet. The banner that matters arrives when the
   * last one does, and it reads identically — so firing now would be a duplicate whose only content
   * is that you cannot act yet.
   */
  it('stays quiet while the job still has an agent working', () => {
    const working = attention({ openThreadCount: 2, turnRunning: true });
    expect(
      turnNotification({ jobTitle: 'Password policy', attention: working, onScreen: false }),
    ).toBeNull();
  });

  /** Out of this machine's hands. Nothing to come back to the terminal for. */
  it('stays quiet for a shipped job, whose court is external', () => {
    const shipped = attention({ openThreadCount: 0, hasPullRequest: true });
    expect(shipped.verb).toBe(EAttentionVerb.shipped);
    expect(
      turnNotification({ jobTitle: 'Password policy', attention: shipped, onScreen: false }),
    ).toBeNull();
  });

  /**
   * A job whose last thread closed is the END of a leg, and at JOB scope that is your court — it is
   * asking for a new phase. At thread scope the same facts read `closed · nobody's court`, which is
   * exactly why the notification is job-scoped.
   */
  it('fires when the last thread closes, because the job now wants a decision', () => {
    const done = attention({ openThreadCount: 0 });
    expect(
      turnNotification({ jobTitle: 'Password policy', attention: done, onScreen: false }),
    ).toEqual({ title: 'Password policy', message: 'has nothing open' });
  });

  /**
   * The guard that keeps this honest as the verb table grows: every verb whose court is yours must
   * have something to say, or a future verb would silently stop notifying.
   */
  it('has a sentence for every verb that leaves the ball with you', () => {
    const yours = [
      attention({ openThreadCount: 1 }),
      attention({ openThreadCount: 1, proposalPending: true }),
      attention({ openThreadCount: 0 }),
    ];
    for (const state of yours) {
      expect(
        turnNotification({ jobTitle: 'j', attention: state, onScreen: false }),
      ).not.toBeNull();
    }
  });
});
