import { describe, expect, it } from 'bun:test';
import {
  baseBranchRefusal,
  parseDefaultBranch,
  parseOpenPullRequest,
  pullRequestFromUrl,
  rebaseFailedMessage,
  shipBranch,
  shippedReply,
} from '../ship.js';

describe('reading gh', () => {
  it('reads the default branch at ship time', () => {
    expect(parseDefaultBranch('{"defaultBranchRef":{"name":"main"}}\n')).toBe('main');
    expect(parseDefaultBranch('{"defaultBranchRef":{"name":"trunk"}}')).toBe('trunk');
  });

  it('answers null for anything that is not the JSON it asked for', () => {
    // An unauthenticated or missing `gh` prints prose. The caller says something better about that
    // than a SyntaxError would.
    expect(parseDefaultBranch('gh: command not found')).toBeNull();
    expect(parseDefaultBranch('{}')).toBeNull();
    expect(parseDefaultBranch('{"defaultBranchRef":null}')).toBeNull();
    expect(parseDefaultBranch('{"defaultBranchRef":{"name":""}}')).toBeNull();
  });

  it('distinguishes "no pull request" from "the question failed"', () => {
    // The distinction idempotence rests on: `[]` means open one, unparseable means do NOT.
    expect(parseOpenPullRequest('[]')).toBeNull();
    expect(parseOpenPullRequest('not json')).toBeNull();
    expect(
      parseOpenPullRequest('[{"number":7,"url":"https://github.com/o/r/pull/7"}]'),
    ).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7' });
  });

  it('takes the first of several — gh lists newest first', () => {
    const listed = parseOpenPullRequest(
      '[{"number":9,"url":"https://github.com/o/r/pull/9"},{"number":7,"url":"https://github.com/o/r/pull/7"}]',
    );
    expect(listed?.number).toBe(9);
  });

  it('skips entries missing either fact rather than half-believing them', () => {
    expect(parseOpenPullRequest('[{"number":"7","url":"u"},{"number":8,"url":"u8"}]')).toEqual({
      number: 8,
      url: 'u8',
    });
    expect(parseOpenPullRequest('[{"number":8}]')).toBeNull();
  });

  it('reads the number back out of the URL `gh pr create` prints', () => {
    expect(pullRequestFromUrl('https://github.com/o/r/pull/12\n')).toEqual({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
    });
  });

  it('ignores the chatter gh prints above the URL', () => {
    // `gh pr create` announces what it is doing on stdout before the URL. The URL is the last line.
    const stdout = 'Creating pull request for atlas/x into main in o/r\n\nhttps://github.com/o/r/pull/3\n';
    expect(pullRequestFromUrl(stdout)?.number).toBe(3);
  });

  it('answers null when there is no number to cache', () => {
    expect(pullRequestFromUrl('')).toBeNull();
    expect(pullRequestFromUrl('https://github.com/o/r/pulls')).toBeNull();
  });
});

describe('which branch a ship turn may push', () => {
  it('ships the job branch when it is the one checked out', () => {
    expect(shipBranch({ jobBranch: 'atlas/drain-1', headBranch: 'atlas/drain-1' })).toEqual({
      ok: true,
      branch: 'atlas/drain-1',
    });
  });

  it('ships whatever is checked out for a job that never took a worktree', () => {
    expect(shipBranch({ jobBranch: null, headBranch: 'feature/x' })).toEqual({
      ok: true,
      branch: 'feature/x',
    });
  });

  it('refuses when the job names a branch that is not checked out here', () => {
    // `Job.branch` set with the worktree gone: the cwd falls back to the project path, where the
    // branch Dennis has open in his editor is checked out. Force-pushing that is the accident.
    const decided = shipBranch({ jobBranch: 'atlas/drain-1', headBranch: 'main' });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.reason).toContain('worktree is gone');
  });

  it('refuses a detached head, or a folder git has never heard of', () => {
    const decided = shipBranch({ jobBranch: null, headBranch: null });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.reason).toContain('HEAD names no branch');
  });
});

describe('the sentences that come back', () => {
  it('refuses to open a pull request from the default branch to itself', () => {
    expect(baseBranchRefusal({ branch: 'main', base: 'main' })).toContain('default branch');
    expect(baseBranchRefusal({ branch: 'atlas/x', base: 'main' })).toBeNull();
  });

  it('says the same thing about the push either way, and differs only about the PR', () => {
    const pr = { number: 4, url: 'https://github.com/o/r/pull/4' };
    const created = shippedReply({ branch: 'atlas/x', base: 'main', pr, created: true });
    const reused = shippedReply({ branch: 'atlas/x', base: 'main', pr, created: false });

    expect(created).toContain('rebased onto `main` and pushed');
    expect(reused).toContain('rebased onto `main` and pushed');
    expect(created).toContain('#4 opened');
    expect(reused).toContain('already existed');
    // A re-ship must not read like a failure — it is the identical operation, said honestly.
    expect(reused).toContain('No second pull request was opened');
  });

  it('says a failed rebase touched nothing and needs a person', () => {
    const message = rebaseFailedMessage({
      base: 'main',
      stderr: 'CONFLICT (content): Merge conflict in src/a.ts\nerror: could not apply 1234\n',
    });
    expect(message).toContain('CONFLICT');
    expect(message).toContain('Nothing was pushed');
    expect(message).toContain('aborted');
  });
});
