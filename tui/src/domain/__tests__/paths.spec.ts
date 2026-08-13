import { describe, expect, it } from 'bun:test';
import { CONTEXT_BUCKETS, expandHome, jobContextDir, jobDir } from '../paths.js';

describe('expandHome', () => {
  const home = '/Users/someone';

  it('expands a leading ~/, which resolve() would otherwise read as a folder named ~', () => {
    expect(expandHome('~/Developer/comp-v2', home)).toBe(
      '/Users/someone/Developer/comp-v2',
    );
  });

  it('expands a bare ~', () => {
    expect(expandHome('~', home)).toBe(home);
  });

  it('leaves absolute and relative paths alone', () => {
    expect(expandHome('/tmp/foo', home)).toBe('/tmp/foo');
    expect(expandHome('../sibling', home)).toBe('../sibling');
  });

  // A tilde anywhere but the front is a literal character in a folder name, and `~other` is another
  // account's home — guessing either would open the wrong folder instead of reporting a miss.
  it('only touches a leading bare tilde', () => {
    expect(expandHome('~other/foo', home)).toBe('~other/foo');
    expect(expandHome('/tmp/~/foo', home)).toBe('/tmp/~/foo');
  });
});

describe('CONTEXT_BUCKETS', () => {
  it('is the three buckets, in the order the phases write them', () => {
    expect(CONTEXT_BUCKETS).toEqual(['charting', 'specs', 'artifacts']);
  });

  // `generated/` lost its writer when hand-offs became the next session's first message rather
  // than files. A stray bucket would be a folder nothing ever fills and agents would still read.
  it('no longer carries generated/', () => {
    expect(CONTEXT_BUCKETS as readonly string[]).not.toContain('generated');
  });
});

describe('job paths', () => {
  it('keeps the context folder inside the job folder, so deleting a job takes it', () => {
    expect(jobContextDir('job-1').startsWith(jobDir('job-1'))).toBe(true);
  });
});
