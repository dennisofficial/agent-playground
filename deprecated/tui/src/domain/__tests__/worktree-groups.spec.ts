import { describe, expect, it } from 'bun:test';
import { EJobEntry, selectableEntries, type JobEntry } from '../job-groups.js';
import { groupJobsByWorktree } from '../worktree-groups.js';
import { EWorkspaceKind } from '../worktree.js';
import type { GitWorktree } from '../worktree-list.js';

const PROJECT = '/repo';

function worktree(path: string, branch: string | null, extra: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path,
    branch,
    head: 'aaaaaaaaaaaa',
    bare: false,
    detached: branch === null,
    locked: false,
    prunable: false,
    ...extra,
  };
}

function job(id: string, workspacePath: string | null = null): { id: string; workspacePath: string | null } {
  return { id, workspacePath };
}

/** `⌂ main · here` for a header, the job id for a row — the whole list as one readable column. */
function sketch(entries: JobEntry<{ id: string }>[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === EJobEntry.worktree) return `${entry.group.glyph} ${entry.group.label}`;
    if (entry.kind === EJobEntry.header) return `# ${entry.projectName}`;
    return entry.job.id;
  });
}

/** Every stop the cursor can reach, in order, labelled the same way. */
function stops(entries: JobEntry<{ id: string }>[]): string[] {
  return sketch(selectableEntries(entries));
}

const MAIN = worktree(PROJECT, 'main');
const LINKED = worktree('/repo/.worktrees/drain-abcdef12', 'atlas/drain-abcdef12');

describe('groupJobsByWorktree', () => {
  it('puts jobs with no worktree of their own under the main worktree', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a'), job('b')],
      worktrees: [MAIN],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here', 'a', 'b']);
  });

  it('files a job under the worktree it recorded', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a'), job('b', LINKED.path)],
      worktrees: [MAIN, LINKED],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here', 'a', '⑂ atlas/drain-abcdef12', 'b']);
  });

  it('keeps the main worktree first even when nothing is standing in it', () => {
    // It names the branch the editor is on and the branch a job with no worktree would commit to.
    // That fact does not stop being worth showing because today's work happens elsewhere.
    const entries = groupJobsByWorktree({
      jobs: [job('a', LINKED.path)],
      worktrees: [MAIN, LINKED],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here', '⑂ atlas/drain-abcdef12', 'a']);
  });

  it('shows a worktree no job is working in, which is the leak nothing else can see', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a')],
      worktrees: [MAIN, LINKED],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here', 'a', '⑂ atlas/drain-abcdef12']);
    const orphan = entries.at(-1);
    expect(orphan?.kind === EJobEntry.worktree && orphan.group.jobCount).toBe(0);
  });

  it('orders worktrees by the recency of the jobs in them, empties last', () => {
    const older = worktree('/repo/.worktrees/older', 'atlas/older');
    const entries = groupJobsByWorktree({
      // Jobs arrive recency-sorted, so first appearance is most-recently-touched.
      jobs: [job('new', LINKED.path), job('old', older.path)],
      worktrees: [MAIN, older, LINKED, worktree('/repo/.worktrees/idle', 'atlas/idle')],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual([
      '⌂ main · here',
      '⑂ atlas/drain-abcdef12',
      'new',
      '⑂ atlas/older',
      'old',
      '⑂ atlas/idle',
    ]);
  });

  it('warns about a recorded worktree git no longer lists, never folding it into the main group', () => {
    // A quiet downgrade to "here" is the one genuinely dangerous answer: the worktree existed to keep
    // the agent out of the tree that fallback would put it back into.
    const entries = groupJobsByWorktree({
      jobs: [job('a', '/repo/.worktrees/gone')],
      worktrees: [MAIN],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual([
      '⌂ main · here',
      '⚠ worktree missing: /repo/.worktrees/gone',
      'a',
    ]);
    const missing = entries[1];
    expect(missing?.kind === EJobEntry.worktree && missing.group.kind).toBe(EWorkspaceKind.missing);
  });

  it('treats a prunable worktree as missing — its directory is gone, the record just survived it', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a', LINKED.path)],
      worktrees: [MAIN, worktree(LINKED.path, LINKED.branch, { prunable: true })],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)[1]).toBe(`⚠ worktree missing: ${LINKED.path}`);
  });

  it('names a detached worktree by its commit, and a locked one as locked', () => {
    const entries = groupJobsByWorktree({
      jobs: [],
      worktrees: [
        MAIN,
        worktree('/repo/.worktrees/loose', null, { head: 'abc1234def567' }),
        worktree('/repo/.worktrees/held', 'atlas/held', { locked: true }),
      ],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual([
      '⌂ main · here',
      '⑂ detached at abc1234',
      '⑂ atlas/held · locked',
    ]);
  });

  it('falls back to a flat list when git said nothing — not a repository, or the read failed', () => {
    // A single heading over every row would be a claim this function cannot support without git.
    const entries = groupJobsByWorktree({
      jobs: [job('a'), job('b')],
      worktrees: [],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['a', 'b']);
  });

  it('matches paths that differ only in shape, so a trailing slash does not mint a phantom group', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a', `${LINKED.path}/`)],
      worktrees: [MAIN, LINKED],
      projectPath: `${PROJECT}/`,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here', '⑂ atlas/drain-abcdef12', 'a']);
  });

  it('indexes rows by where they are DRAWN, so ↓ lands where the eye went', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a'), job('b', LINKED.path), job('c', LINKED.path)],
      worktrees: [MAIN, LINKED],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    const drawn = entries.flatMap((e) => (e.kind === EJobEntry.job ? [[e.job.id, e.index]] : []));
    expect(drawn).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('draws the main worktree alone when there are no jobs at all', () => {
    const entries = groupJobsByWorktree({
      jobs: [],
      worktrees: [MAIN],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here']);
  });
});

describe('groupJobsByWorktree while a filter is running', () => {
  it('drops every heading with nothing left under it, so typing narrows instead of sprouting', () => {
    // The failure this prevents: a query matching one job in one worktree, drawn as five headings and
    // a single row. A filter is a search — it must not turn the list into furniture.
    const entries = groupJobsByWorktree({
      jobs: [job('a', LINKED.path)],
      worktrees: [MAIN, LINKED, worktree('/repo/.worktrees/idle', 'atlas/idle')],
      projectPath: PROJECT,
      includeEmpty: false,
    });
    expect(sketch(entries)).toEqual(['⑂ atlas/drain-abcdef12', 'a']);
  });

  it('still groups what DID match, so a hit keeps saying which tree it is in', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a'), job('b', LINKED.path)],
      worktrees: [MAIN, LINKED],
      projectPath: PROJECT,
      includeEmpty: false,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here', 'a', '⑂ atlas/drain-abcdef12', 'b']);
  });

  it('keeps a missing worktree, which is never empty and never droppable', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a', '/repo/.worktrees/gone')],
      worktrees: [MAIN],
      projectPath: PROJECT,
      includeEmpty: false,
    });
    expect(sketch(entries)).toEqual(['⚠ worktree missing: /repo/.worktrees/gone', 'a']);
  });

  it('indexes the rows it kept, not the rows it would have drawn', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a', LINKED.path), job('b', LINKED.path)],
      worktrees: [MAIN, LINKED],
      projectPath: PROJECT,
      includeEmpty: false,
    });
    const drawn = entries.flatMap((e) => (e.kind === EJobEntry.job ? [[e.job.id, e.index]] : []));
    expect(drawn).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });
});

describe('what the cursor can land on', () => {
  it('makes an empty worktree a stop, and a worktree with jobs furniture', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a', LINKED.path)],
      worktrees: [MAIN, LINKED, worktree('/repo/.worktrees/idle', 'atlas/idle')],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    // `⑂ atlas/drain-abcdef12` has a job under it, so it is a heading and not a stop.
    expect(stops(entries)).toEqual(['a', '⑂ atlas/idle']);
  });

  it('never makes the main worktree a stop, empty or not', () => {
    // Nothing to release and nothing to adopt — `+ new job` already puts a job there, so a stop on it
    // would be a stop no key does anything with.
    const entries = groupJobsByWorktree({
      jobs: [],
      worktrees: [MAIN],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    expect(sketch(entries)).toEqual(['⌂ main · here']);
    expect(stops(entries)).toEqual([]);
  });

  it('walks jobs and empty worktrees under ONE counter, in draw order', () => {
    const entries = groupJobsByWorktree({
      jobs: [job('a'), job('b', LINKED.path)],
      worktrees: [MAIN, LINKED, worktree('/repo/.worktrees/idle', 'atlas/idle')],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    // The stamped index has to equal the position in the stop list, or ↓ lands off the highlight.
    const indices = selectableEntries(entries).map((entry) =>
      entry.kind === EJobEntry.header ? -1 : entry.index,
    );
    expect(indices).toEqual([0, 1, 2]);
    expect(stops(entries)).toEqual(['a', 'b', '⑂ atlas/idle']);
  });

  it('carries the real branch for adoption, not the label prose', () => {
    // `label` may read `atlas/held · locked`; writing that into `Job.branch` would ship a push of a
    // branch that does not exist.
    const entries = groupJobsByWorktree({
      jobs: [],
      worktrees: [MAIN, worktree('/repo/.worktrees/held', 'atlas/held', { locked: true })],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    const held = selectableEntries(entries)[0];
    expect(held?.kind === EJobEntry.worktree && held.group.label).toBe('atlas/held · locked');
    expect(held?.kind === EJobEntry.worktree && held.group.branch).toBe('atlas/held');
  });

  it('leaves branch null on a detached worktree, so adoption can refuse it', () => {
    const entries = groupJobsByWorktree({
      jobs: [],
      worktrees: [MAIN, worktree('/repo/.worktrees/loose', null, { head: 'abc1234def' })],
      projectPath: PROJECT,
      includeEmpty: true,
    });
    const loose = selectableEntries(entries)[0];
    expect(loose?.kind === EJobEntry.worktree && loose.group.branch).toBeNull();
  });
});
