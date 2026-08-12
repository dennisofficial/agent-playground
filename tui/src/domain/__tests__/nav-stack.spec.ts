import { describe, expect, it } from 'bun:test';
import { popFrame, pushFrames, replaceFrame, toggleFrame } from '../nav-stack.js';

const sameName = (a: string, b: string): boolean => a === b;

describe('pushFrames', () => {
  it('deepens the stack by one', () => {
    expect(pushFrames(['jobs'], 'conversation')).toEqual(['jobs', 'conversation']);
  });

  it('pushes several frames at once, landing on the last', () => {
    // The whole mechanism behind "descending may skip levels, ascending never does": opening a job
    // goes straight to the conversation, but threads is really underneath it, so `pop` unwinds the
    // circle for free and no page needs a double-pop rule.
    expect(pushFrames(['jobs'], 'threads', 'conversation')).toEqual([
      'jobs',
      'threads',
      'conversation',
    ]);
  });

  it('is a no-op when given nothing to push', () => {
    expect(pushFrames(['jobs'])).toEqual(['jobs']);
  });
});

describe('popFrame', () => {
  it('unwinds one frame at a time', () => {
    expect(popFrame(['jobs', 'threads', 'conversation'])).toEqual(['jobs', 'threads']);
  });

  it('never empties the stack — an empty stack has no page to draw', () => {
    expect(popFrame(['jobs'])).toEqual(['jobs']);
  });
});

describe('the circle', () => {
  it('walks jobs → conversation → threads → jobs', () => {
    const opened = pushFrames(['jobs'], 'threads', 'conversation');
    expect(opened.at(-1)).toBe('conversation');

    const back = popFrame(opened);
    expect(back.at(-1)).toBe('threads');

    const home = popFrame(back);
    expect(home).toEqual(['jobs']);
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
