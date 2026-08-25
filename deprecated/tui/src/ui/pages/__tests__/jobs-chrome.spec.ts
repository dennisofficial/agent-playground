import { describe, expect, it } from 'bun:test';
import { EJobEntry, type JobEntry } from '../../../domain/job-groups.js';
import type { WorktreeGroup } from '../../../domain/worktree.js';
import type { JobRow } from '../../../store/job.repository.js';
import {
  ACTION_LABELS,
  actionFor,
  ARCHIVED_HINTS,
  EJobAction,
  EMPTY_HINTS,
  HINTS,
  hintsFor,
  UNSCOPED_HINTS,
  WORKTREE_HINTS,
} from '../jobs-chrome.js';

/** The cursor on a worktree that holds no jobs — the one row whose verbs are not the list's. */
const onWorktree: JobEntry<JobRow> = {
  kind: EJobEntry.worktree,
  group: { label: 'feat/x' } as WorktreeGroup,
  index: null,
};

describe('actionFor', () => {
  it('offers a new job wherever there is a project to put one in', () => {
    expect(actionFor({ view: 'open', canCreate: true, empty: false })).toBe(EJobAction.newJob);
    expect(actionFor({ view: 'open', canCreate: true, empty: true })).toBe(EJobAction.newJob);
  });

  it('offers the switcher when there are no jobs anywhere', () => {
    // The first run, and the one empty state that cannot point at `+ new job`: a job needs somewhere
    // to live, and standing outside every repository there is no here. Without this the widest list
    // in the app had no action on it at all — a blank page that reads as a broken one.
    expect(actionFor({ view: 'open', canCreate: false, empty: true })).toBe(
      EJobAction.pickProject,
    );
  });

  it('offers nothing on the unscoped list once there are jobs to look at', () => {
    // The rows are the content there, and `p` is on the hint line. A `+ pick a project…` row under a
    // list you are already reading is furniture.
    expect(actionFor({ view: 'open', canCreate: false, empty: false })).toBeNull();
  });

  it('offers nothing on the shelf, empty or not', () => {
    // A job you create is a job you are working on, by definition — and there is nothing to pick a
    // project FOR while looking at what you have put away.
    expect(actionFor({ view: 'archived', canCreate: false, empty: true })).toBeNull();
    expect(actionFor({ view: 'archived', canCreate: true, empty: false })).toBeNull();
  });

  it('has a label for every action, because the row has to say what it does', () => {
    expect(ACTION_LABELS[EJobAction.newJob]).toBe('+ new job');
    expect(ACTION_LABELS[EJobAction.pickProject]).toContain('project');
  });
});

describe('hintsFor', () => {
  it('follows the cursor onto a worktree, over anything the page would say', () => {
    expect(
      hintsFor({
        view: 'open',
        canCreate: true,
        highlighted: onWorktree,
        action: EJobAction.newJob,
      }),
    ).toBe(WORKTREE_HINTS);
  });

  it('names only the two keys that work when there is nothing anywhere', () => {
    // `open`, `archive` and `delete` all need a row. Advertising them over a page with none is how a
    // first run came to look like a failure.
    const hints = hintsFor({
      view: 'open',
      canCreate: false,
      highlighted: undefined,
      action: EJobAction.pickProject,
    });
    expect(hints).toBe(EMPTY_HINTS);
    for (const form of hints) {
      expect(form).not.toContain('archive');
      expect(form).not.toContain('delete');
    }
  });

  it('drops `n new` where there is no here to create a job in', () => {
    const hints = hintsFor({
      view: 'open',
      canCreate: false,
      highlighted: undefined,
      action: null,
    });
    expect(hints).toBe(UNSCOPED_HINTS);
    for (const form of hints) expect(form).not.toContain('n new');
  });

  it('names the way out to every job, on the only page that has one', () => {
    // Scoped and unscoped are the same page, so nothing on screen says the wider list exists. The
    // widest hint form is where it gets said; the unscoped list must not claim it back.
    expect(HINTS[0]).toContain('← all jobs');
    for (const form of UNSCOPED_HINTS) expect(form).not.toContain('all jobs');
  });

  it('lets the shelf win over the page it is a shelf of', () => {
    expect(
      hintsFor({
        view: 'archived',
        canCreate: false,
        highlighted: undefined,
        action: null,
      }),
    ).toBe(ARCHIVED_HINTS);
  });
});
