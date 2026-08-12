import { describe, expect, it } from 'bun:test';
import { sep } from 'node:path';
import { ContextFolderService } from '../context-folder.service.js';
import { CONTEXT_BUCKETS, jobContextDir } from '../../domain/paths.js';
import { contextMentionLabel, relativeToRoot } from '../context-folder.service.js';

/**
 * `resolveInside` is the only door into a job's context folder for a path the AGENT named, so these
 * are containment tests, not path-formatting tests. They construct the service directly — nothing it
 * does here touches the filesystem.
 */
const service = new ContextFolderService();
const JOB = 'job-1';
const root = jobContextDir(JOB);

describe('resolveInside', () => {
  it('resolves a bucket-relative path under the job root', () => {
    expect(service.resolveInside({ jobId: JOB, relativePath: 'specs/api.md' })).toBe(
      `${root}${sep}specs${sep}api.md`,
    );
  });

  it('allows the root itself', () => {
    expect(service.resolveInside({ jobId: JOB, relativePath: '.' })).toBe(root);
  });

  it('refuses to climb out with ..', () => {
    expect(() => service.resolveInside({ jobId: JOB, relativePath: '../../etc/passwd' })).toThrow(
      'escapes the job context folder',
    );
  });

  it('refuses a climb hidden in the middle of a path', () => {
    expect(() =>
      service.resolveInside({ jobId: JOB, relativePath: 'specs/../../../.ssh/id_rsa' }),
    ).toThrow('escapes the job context folder');
  });

  it('refuses an absolute path, which resolve() would otherwise honour outright', () => {
    expect(() => service.resolveInside({ jobId: JOB, relativePath: '/etc/passwd' })).toThrow(
      'escapes the job context folder',
    );
  });

  it('refuses a sibling job whose directory merely shares the prefix', () => {
    // `…/jobs/job-1-evil` starts with `…/jobs/job-1` as a STRING; only the separator check rejects it.
    expect(() => service.resolveInside({ jobId: JOB, relativePath: `..${sep}..${sep}job-1-evil` })).toThrow(
      'escapes the job context folder',
    );
  });

  it('keeps a path that merely contains .. in a filename', () => {
    expect(service.resolveInside({ jobId: JOB, relativePath: 'artifacts/a..b.png' })).toBe(
      `${root}${sep}artifacts${sep}a..b.png`,
    );
  });
});

describe('root and buckets', () => {
  it('scopes every job to its own folder', () => {
    expect(service.root('job-1')).not.toBe(service.root('job-2'));
  });

  it('labels a mention with forward slashes whatever the platform separator is', () => {
    const label = contextMentionLabel({
      bucket: CONTEXT_BUCKETS[0],
      path: ['a', 'b.md'].join(sep),
      bytes: 0,
      modifiedAt: new Date(0),
      isDirectory: false,
    });
    expect(label).toBe(`context/${CONTEXT_BUCKETS[0]}/a/b.md`);
  });

  it('relativises with forward slashes too, so a mention round-trips', () => {
    expect(relativeToRoot(root, `${root}${sep}specs${sep}api.md`)).toBe('specs/api.md');
  });
});
