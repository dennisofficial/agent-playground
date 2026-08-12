import { describe, expect, it } from 'bun:test';
import { CONTEXT_BUCKETS, jobContextDir, jobDir } from '../paths.js';

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
