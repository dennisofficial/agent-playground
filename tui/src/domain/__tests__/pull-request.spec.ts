import { describe, expect, it } from 'bun:test';
import {
  pullRequestFromUrl,
  pullRequestRefusal,
  recordedReply,
} from '../pull-request.js';

describe('pullRequestFromUrl', () => {
  it('reads the number out of a plain url', () => {
    expect(pullRequestFromUrl('https://github.com/dennis/atlas/pull/42')).toEqual({
      number: 42,
      url: 'https://github.com/dennis/atlas/pull/42',
    });
  });

  it('takes the last line, because that is what `gh pr create` prints', () => {
    // Real `gh` output: progress chatter, then the URL. Tolerating it is the difference between one
    // tool call and a round trip spent explaining what a URL is.
    const stdout = [
      'Warning: 3 uncommitted changes',
      'Creating pull request for atlas/x into main in dennis/atlas',
      '',
      'https://github.com/dennis/atlas/pull/7',
    ].join('\n');
    expect(pullRequestFromUrl(stdout)?.number).toBe(7);
  });

  it('accepts enterprise hosts and trailing path or query', () => {
    expect(pullRequestFromUrl('https://git.acme.co/team/repo/pull/1234/files')?.number).toBe(1234);
    expect(pullRequestFromUrl('https://github.com/a/b/pull/9?w=1')?.number).toBe(9);
  });

  it('answers null for anything that is not a pull request url', () => {
    for (const value of [
      '',
      '   ',
      'yes',
      '42',
      // The ISSUE url for the same repo — a wrong number recorded silently is worse than a refusal.
      'https://github.com/dennis/atlas/issues/42',
      // No scheme: `gh` never prints this, and accepting it invites a hand-typed guess.
      'github.com/dennis/atlas/pull/42',
      'https://github.com/dennis/atlas/pull/',
      'https://github.com/dennis/atlas/pull/abc',
    ]) {
      expect(pullRequestFromUrl(value)).toBeNull();
    }
  });
});

describe('pullRequestRefusal', () => {
  it('quotes what it was given and says nothing was recorded', () => {
    const message = pullRequestRefusal('yes it worked');
    expect(message).toContain('yes it worked');
    expect(message).toContain('Nothing was recorded');
  });
});

describe('recordedReply', () => {
  const pr = { number: 42, url: 'https://github.com/dennis/atlas/pull/42' };

  it('reads as a first record when the job had none', () => {
    expect(recordedReply({ pr, previous: null })).toContain('recorded against this job');
  });

  /**
   * The load-bearing one. A ci thread that pushes again and re-records is doing exactly what the
   * brief asks, so the reply must not sound like a warning — a reply that did would teach it to
   * stop calling this, and the render cache would rot.
   */
  it('reads as a no-op, not a problem, when the number is unchanged', () => {
    const reply = recordedReply({ pr, previous: 42 });
    expect(reply).toContain('Still pull request #42');
    expect(reply).toContain('expected answer for a re-ship');
  });

  it('names the one it replaced when the number actually moved', () => {
    const reply = recordedReply({ pr, previous: 7 });
    expect(reply).toContain('#42');
    expect(reply).toContain('#7');
  });

  it('says plainly that nothing watches it', () => {
    // No webhooks, no polling: an agent that thought this number was live state would wait on it.
    expect(recordedReply({ pr, previous: null })).toContain('Nothing watches it');
  });
});
