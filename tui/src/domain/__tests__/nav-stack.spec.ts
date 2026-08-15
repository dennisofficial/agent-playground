import { describe, expect, it } from 'bun:test';
import {
  popFrame,
  popToName,
  pushFrames,
  replaceFrame,
  resetTo,
  toggleFrame,
} from '../nav-stack.js';

const sameName = (a: string, b: string): boolean => a === b;

describe('pushFrames', () => {
  it('deepens the stack by one', () => {
    expect(pushFrames(['jobs'], 'conversation')).toEqual(['jobs', 'conversation']);
  });

  it('can still push several frames at once, though nothing does any more', () => {
    // Opening a job used to push `threads` AND `conversation` so that `←` revealed the job's page on
    // the way out. It made one key mean "leave" everywhere and "manage this job" in one place; the
    // job's page moved ABOVE the conversation and every arrival is one frame now. The variadic form
    // survives because a caller with two frames to push should not have to sequence two setStates.
    expect(pushFrames(['jobs'], 'conversation', 'threads')).toEqual([
      'jobs',
      'conversation',
      'threads',
    ]);
  });

  it('is a no-op when given nothing to push', () => {
    expect(pushFrames(['jobs'])).toEqual(['jobs']);
  });
});

describe('popFrame', () => {
  it('unwinds one frame at a time', () => {
    expect(popFrame(['jobs', 'conversation', 'threads'])).toEqual(['jobs', 'conversation']);
  });

  it('never empties the stack — an empty stack has no page to draw', () => {
    expect(popFrame(['jobs'])).toEqual(['jobs']);
  });
});

describe('the ladder', () => {
  it('descends jobs → conversation → the job, and `←` walks back down it', () => {
    // Every step is one frame and `←` is its exact inverse, at every level. That is the whole of the
    // navigation design now: no page is entered by pushing two frames, so no page has to explain why
    // going back from it lands somewhere you were never taken.
    const conversation = pushFrames(['jobs'], 'conversation');
    const job = pushFrames(conversation, 'threads');

    expect(popFrame(job)).toEqual(['jobs', 'conversation']);
    expect(popFrame(popFrame(job))).toEqual(['jobs']);
  });

  it('leaves the job list at the bottom, where `←` has nothing left to do', () => {
    // The scoped and unscoped lists are ONE frame whose scope is state, so the root is the root
    // whichever one you are looking at — and a page with nothing behind it must not draw a `‹`.
    expect(popFrame(['jobs'])).toEqual(['jobs']);
  });
});

describe('resetTo', () => {
  it('throws away everything and stands on one frame', () => {
    // Choosing a project from the switcher. Pushing the scoped list instead put a page identical to
    // the one you were looking at two frames underneath it — the same header, the same rows, a
    // different `←` — which is exactly the confusion this removes.
    expect(resetTo('jobs')).toEqual(['jobs']);
  });
});

describe('replaceFrame', () => {
  it('swaps the current frame without deepening', () => {
    expect(replaceFrame(['jobs', 'threads'], 'accounts')).toEqual(['jobs', 'accounts']);
  });
});

describe('toggleFrame', () => {
  it('pushes when the frame is not current', () => {
    expect(toggleFrame(['jobs'], 'accounts', sameName)).toEqual(['jobs', 'accounts']);
  });

  it('pops back off when it already is', () => {
    expect(toggleFrame(['jobs', 'accounts'], 'accounts', sameName)).toEqual(['jobs']);
  });

  it('refuses to pop the root, even to toggle', () => {
    expect(toggleFrame(['accounts'], 'accounts', sameName)).toEqual(['accounts']);
  });
});

describe('popToName', () => {
  const nameOf = (frame: string): string => frame;

  it('unwinds from wherever you are to the named page', () => {
    // The two arrival paths at the job's page: from a conversation, and straight from the list when
    // the job is shipped. Switching threads rewinds through either without counting frames.
    expect(popToName(['jobs', 'conversation', 'threads'], 'jobs', nameOf)).toEqual(['jobs']);
    expect(popToName(['jobs', 'threads'], 'jobs', nameOf)).toEqual(['jobs']);
  });

  it('is a no-op when you are already there', () => {
    expect(popToName(['jobs'], 'jobs', nameOf)).toEqual(['jobs']);
  });

  it('stops at the topmost match rather than the deepest', () => {
    // Generic behaviour, asserted because the alternative is worse: unwinding to the DEEPEST match
    // would walk past pages you were still using. Two job lists no longer happen — scope is state on
    // one frame — but nothing here knows that, and it should not have to.
    expect(popToName(['jobs', 'jobs', 'threads'], 'jobs', nameOf)).toEqual(['jobs', 'jobs']);
  });

  it('stops at the root rather than emptying when the name is not there', () => {
    expect(popToName(['jobs', 'accounts'], 'threads', nameOf)).toEqual(['jobs']);
  });
});
