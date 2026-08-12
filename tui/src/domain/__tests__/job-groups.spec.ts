import { describe, expect, it } from 'bun:test';
import { EJobEntry, groupJobs, type JobEntry } from '../job-groups.js';

type Fake = { id: string; projectId: string; projectName: string };

const job = (id: string, projectId: string): Fake => ({
  id,
  projectId,
  projectName: projectId.toUpperCase(),
});

const ids = (entries: readonly JobEntry<Fake>[]): string[] =>
  entries.map((entry) =>
    entry.kind === EJobEntry.header ? `# ${entry.projectName}` : entry.job.id,
  );

describe('groupJobs, ungrouped', () => {
  it('emits no headers at all', () => {
    // Launched inside a repo the list is one project's, so a header would name the thing you are
    // already standing in. The filter IS the grouping collapsing.
    const entries = groupJobs({ jobs: [job('a', 'atlas'), job('b', 'atlas')], grouped: false });
    expect(ids(entries)).toEqual(['a', 'b']);
  });

  it('leaves the given order alone', () => {
    const entries = groupJobs({ jobs: [job('b', 'api'), job('a', 'atlas')], grouped: false });
    expect(ids(entries)).toEqual(['b', 'a']);
  });
});

describe('groupJobs, grouped', () => {
  it('puts a header above each project', () => {
    const entries = groupJobs({ jobs: [job('a', 'atlas'), job('b', 'api')], grouped: true });
    expect(ids(entries)).toEqual(['# ATLAS', 'a', '# API', 'b']);
  });

  it('orders projects by their most recent job, not alphabetically', () => {
    // The input arrives sorted by recency, so first appearance IS most-recently-touched. Sorting
    // the groups any other way would bury the project you were working in ten seconds ago.
    const entries = groupJobs({ jobs: [job('a', 'zed'), job('b', 'api')], grouped: true });
    expect(ids(entries)).toEqual(['# ZED', 'a', '# API', 'b']);
  });

  it('gathers a project’s jobs rather than chunking runs of them', () => {
    // The case that earns the function. Globally sorted by recency means one project's jobs are
    // INTERLEAVED with another's; a naive chunk-on-change would emit the same header twice.
    const entries = groupJobs({
      jobs: [job('a', 'atlas'), job('b', 'api'), job('c', 'atlas')],
      grouped: true,
    });
    expect(ids(entries)).toEqual(['# ATLAS', 'a', 'c', '# API', 'b']);
  });

  it('keeps recency order inside a group', () => {
    const entries = groupJobs({
      jobs: [job('a', 'atlas'), job('b', 'api'), job('c', 'atlas')],
      grouped: true,
    });
    const atlas = entries.filter((e) => e.kind === EJobEntry.job && e.job.projectId === 'atlas');
    expect(atlas.map((e) => (e.kind === EJobEntry.job ? e.job.id : ''))).toEqual(['a', 'c']);
  });
});

describe('cursor indices', () => {
  it('numbers jobs contiguously across groups, so headers are not selectable', () => {
    // The cursor walks JOBS. Headers are furniture: making them selectable would put dead stops in
    // the middle of a list whose whole purpose is to be arrowed through.
    const entries = groupJobs({
      jobs: [job('a', 'atlas'), job('b', 'api'), job('c', 'atlas')],
      grouped: true,
    });
    const indexed = entries.flatMap((e) => (e.kind === EJobEntry.job ? [[e.job.id, e.index]] : []));
    expect(indexed).toEqual([
      ['a', 0],
      ['c', 1],
      ['b', 2],
    ]);
  });

  it('numbers in the order the rows are DRAWN, not the order they arrived', () => {
    // `c` arrives third and draws second, so pressing ↓ once from `a` must land on `c`.
    const entries = groupJobs({
      jobs: [job('a', 'atlas'), job('b', 'api'), job('c', 'atlas')],
      grouped: true,
    });
    const drawn = entries.filter((e) => e.kind === EJobEntry.job);
    expect(drawn.every((e, position) => e.kind === EJobEntry.job && e.index === position)).toBe(
      true,
    );
  });
});

describe('edges', () => {
  it('returns nothing for no jobs', () => {
    expect(groupJobs({ jobs: [], grouped: true })).toEqual([]);
    expect(groupJobs({ jobs: [], grouped: false })).toEqual([]);
  });
});
