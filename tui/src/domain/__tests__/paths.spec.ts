import { describe, expect, it } from 'bun:test';
import { sep } from 'node:path';
import {
  CONTEXT_BUCKETS,
  expandHome,
  jobContextDir,
  jobDir,
  jobLogsDir,
  jobServicesFile,
  serviceLogFile,
} from '../paths.js';

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

  // Both are inside `jobDir` for the same reason: deleting a job must take its services' logs and
  // its record of them, or the tree is gone and the leak has nothing left to point at.
  it('keeps the services mirror and the logs inside the job folder', () => {
    expect(jobServicesFile('job-1')).toBe(`${jobDir('job-1')}${sep}services.json`);
    expect(jobLogsDir('job-1')).toBe(`${jobDir('job-1')}${sep}logs`);
  });
});

/**
 * A service id becomes a FILENAME, so this is a containment test, not a formatting one — the same
 * shape as `ContextFolderService.resolveInside`, and the only thing between "Atlas mints the ids"
 * and an id that names something outside the job.
 */
describe('serviceLogFile', () => {
  const root = jobLogsDir('job-1');

  it('puts a service log under the job logs folder', () => {
    expect(serviceLogFile({ jobId: 'job-1', serviceId: 'a1b2c3d4' })).toBe(
      `${root}${sep}a1b2c3d4.log`,
    );
  });

  it('refuses to climb out with ..', () => {
    expect(() => serviceLogFile({ jobId: 'job-1', serviceId: '../../evil' })).toThrow(
      'escapes the job folder',
    );
  });

  it('refuses a climb hidden in the middle', () => {
    expect(() =>
      serviceLogFile({ jobId: 'job-1', serviceId: 'ok/../../../.ssh/authorized_keys' }),
    ).toThrow('escapes the job folder');
  });

  it('refuses an absolute id, which resolve() would otherwise honour outright', () => {
    expect(() => serviceLogFile({ jobId: 'job-1', serviceId: '/tmp/evil' })).toThrow(
      'escapes the job folder',
    );
  });

  // The `.log` suffix is what makes a BARE `..` harmless: it becomes the filename `...log` rather
  // than the parent directory. Pinned because the containment check is easy to read as covering this
  // case, and it is the suffix doing the work — a builder that dropped it would open a hole.
  it('turns a bare .. into a filename rather than a directory climb', () => {
    expect(serviceLogFile({ jobId: 'job-1', serviceId: '..' })).toBe(
      `${root}${sep}...log`,
    );
  });
});
