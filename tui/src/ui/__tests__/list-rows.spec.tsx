import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import React from 'react';
import type { ProjectRow } from '../../app/workspace.service.js';
import type { JobRow } from '../../store/job.repository.js';
import { attentionFor, EAttentionScope, NO_FACTS } from '../../domain/attention.js';
import { jobsLayout } from '../../domain/jobs-list.js';
import { projectsLayout } from '../../domain/projects-list.js';
import { threadList, threadsLayout, type ThreadListSource } from '../../domain/threads-list.js';
import { EEngine, EPhaseKind, EThreadRole, EThreadStatus } from '../../generated/prisma/enums.js';
import { EWorkspaceKind, type WorktreeGroup } from '../../domain/worktree.js';
import { JobListRow, WorktreeGroupHeader } from '../components/job-list.js';
import { ProjectListRow } from '../components/project-list.js';
import { PhaseGroup } from '../components/thread-list.js';

/**
 * Every LIST row, mounted for real, at every width and in every condition it can be in.
 *
 * All three rows are spans inside a `<text>` — the shape that took the accounts page down twice —
 * and all three grew a second colour channel with the attention states, so all three are drawn
 * here rather than reasoned about. See `render-smoke.spec.tsx` for the same argument at length.
 */

async function mount(node: React.ReactNode): Promise<void> {
  const renderer = await createCliRenderer({ width: 100, height: 30, useMouse: false });
  try {
    createRoot(renderer).render(<>{node}</>);
    // A frame has to actually be built; mounting alone does not append children.
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    renderer.destroy?.();
  }
}

/**
 * The thread list's row is spans inside a `<text>` — the same shape that took the accounts page
 * down — and every state draws a different set of them. Each width picks a different column form,
 * including the one that has dropped every column but the role.
 */
const THREADS: ThreadListSource[] = [
  {
    id: 't1',
    role: EThreadRole.charting,
    status: EThreadStatus.closed,
    phaseId: 'p1',
    phaseKind: EPhaseKind.charting,
    phaseTitle: null,
    engine: EEngine.claude,
    messageCount: 38,
    sessionCount: 1,
    lastMessageAt: new Date('2026-08-11T09:00:00Z'),
    lastSeenAt: new Date('2026-08-11T09:30:00Z'),
  },
  {
    id: 't2',
    role: EThreadRole.plan_review,
    status: EThreadStatus.closed,
    phaseId: 'p2',
    phaseKind: EPhaseKind.planning,
    phaseTitle: null,
    engine: EEngine.codex,
    messageCount: 19,
    sessionCount: 1,
    // Unseen: the dot fills while the verb still says what the row owes.
    lastMessageAt: new Date('2026-08-11T10:00:00Z'),
    lastSeenAt: new Date('2026-08-11T09:00:00Z'),
  },
  {
    id: 't3',
    role: EThreadRole.builder,
    status: EThreadStatus.active,
    phaseId: 'p3',
    phaseKind: EPhaseKind.build,
    phaseTitle: null,
    engine: EEngine.claude,
    messageCount: 136,
    sessionCount: 2,
    lastMessageAt: new Date('2026-08-11T10:00:00Z'),
    lastSeenAt: null,
  },
  {
    id: 't4',
    role: EThreadRole.master_review,
    status: EThreadStatus.active,
    phaseId: 'p3',
    phaseKind: EPhaseKind.build,
    phaseTitle: null,
    engine: null,
    messageCount: 0,
    sessionCount: 0,
    lastMessageAt: null,
    lastSeenAt: null,
  },
];

describe('thread list rows mount', () => {
  it.each([200, 100, 70, 50, 30])('renders every thread state at %i columns', async (width) => {
    const { groups } = threadList({
      threads: THREADS,
      activeThreadId: 't3',
      runningThreadIds: ['t3'],
    });

    await expect(
      mount(
        <>
          {groups.map((group) => (
            <PhaseGroup
              key={group.phaseId}
              group={group}
              cursor={0}
              layout={threadsLayout(width)}
              frame="⠋"
            />
          ))}
        </>,
      ),
    ).resolves.toBeUndefined();
  });
});


/**
 * The job and project rows, in every court a row can be in. Both are spans inside a `<text>`, and
 * both grew a second colour channel with the attention states — so both get mounted for real.
 */
const JOB: JobRow = {
  id: 'j1',
  projectId: 'p1',
  projectName: 'atlas',
  title: 'add rotation nudges',
  activeThreadId: 't1',
  archivedAt: null,
  branch: null,
  workspacePath: null,
  prNumber: null,
  createdAt: new Date('2026-08-11T09:00:00Z'),
  updatedAt: new Date('2026-08-11T10:00:00Z'),
  activeRole: EThreadRole.builder,
  activePhase: EPhaseKind.build,
  messageCount: 12,
  threads: [
    { id: 't1', closed: false, lastMessageAt: new Date('2026-08-11T10:00:00Z'), lastSeenAt: null },
    { id: 't2', closed: true, lastMessageAt: null, lastSeenAt: null },
  ],
};

const PROJECT: ProjectRow = {
  id: 'p1',
  name: 'atlas',
  path: '/Users/dennis/Developer/atlas',
  lastOpenedAt: new Date('2026-08-11T10:00:00Z'),
  jobCount: 3,
  exists: true,
};

const COURTS = [
  NO_FACTS,
  { ...NO_FACTS, openThreadCount: 1 },
  { ...NO_FACTS, openThreadCount: 1, unseen: true },
  { ...NO_FACTS, openThreadCount: 1, turnRunning: true },
  { ...NO_FACTS, openThreadCount: 1, proposalPending: true },
  { ...NO_FACTS, hasPullRequest: true },
];

/**
 * The two facts a job row SOURCES rather than derives, asserted on the drawn frame.
 *
 * Both were left as optional named arguments defaulting to empty when the attention system landed,
 * so both were silently unreachable: the precedence, the colours and the words were all built and
 * tested, and the row simply never said them. A mount test cannot catch that — the row renders
 * perfectly well saying the wrong thing — so these read the pixels back.
 */
describe('a job row says what it owes', () => {
  async function frameOf(job: JobRow, proposalThreadIds: string[]): Promise<string> {
    const setup = await testRender(
      <box flexDirection="column" width={100} height={3}>
        <JobListRow
          job={job}
          selected={false}
          layout={jobsLayout(100)}
          frame="⠋"
          runningThreadIds={[]}
          proposalThreadIds={proposalThreadIds}
        />
      </box>,
      { width: 100, height: 3 },
    );
    try {
      await setup.flush();
      return setup.captureCharFrame();
    } finally {
      setup.renderer.destroy();
    }
  }

  const QUIET: JobRow = {
    ...JOB,
    threads: [{ id: 't1', closed: true, lastMessageAt: null, lastSeenAt: null }],
  };

  it('says `confirm` when one of its threads is holding a proposal', async () => {
    expect(await frameOf(JOB, ['t1'])).toContain('confirm');
  });

  // `shipped` needs BOTH: a pull request, and nothing open. A job with a PR and a live thread still
  // owes you a reply — the PR is a fact about the work, not a verdict on the conversation.
  it('says `shipped` for a finished job whose pull request is up', async () => {
    expect(await frameOf({ ...QUIET, prNumber: 42 }, [])).toContain('shipped');
    expect(await frameOf(QUIET, [])).toContain('start a phase');
    expect(await frameOf({ ...JOB, prNumber: 42 }, [])).toContain('reply');
  });
});

describe('job and project rows mount', () => {
  it.each([200, 100, 70, 50, 30])('renders a job row at %i columns', async (width) => {
    await expect(
      mount(
        <JobListRow
          job={JOB}
          selected
          layout={jobsLayout(width)}
          frame="⠋"
          runningThreadIds={['t1']}
        />,
      ),
    ).resolves.toBeUndefined();
  });

  // A job waiting on a keypress. The row takes the proposing THREAD rather than a job-level flag,
  // so `attentionFor` stays the only place `confirm` outranks `working…` — note `t1` is running
  // here as well, which is exactly the collision that ordering exists to settle.
  it('renders a job row holding a proposal', async () => {
    await expect(
      mount(
        <JobListRow
          job={JOB}
          selected
          layout={jobsLayout(100)}
          frame="⠋"
          runningThreadIds={['t1']}
          proposalThreadIds={['t1']}
        />,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([200, 100, 70, 50, 30])('renders a project row in every court at %i columns', async (width) => {
    await expect(
      mount(
        <>
          {COURTS.map((facts, index) => (
            <ProjectListRow
              key={index}
              project={index === COURTS.length - 1 ? { ...PROJECT, exists: false } : PROJECT}
              attention={attentionFor({ facts, scope: EAttentionScope.job })}
              selected={index === 0}
              layout={projectsLayout(width)}
              frame="⠋"
            />
          ))}
        </>,
      ),
    ).resolves.toBeUndefined();
  });
});

/**
 * The worktree header, drawn. It is spans inside a `<text>` like every row above it, and its whole
 * job is to SAY something — a header that mounted cleanly while naming no branch would be indis-
 * tinguishable from a working one, so the frame is read back rather than the mount asserted.
 */
describe('a worktree header names the tree its jobs stand in', () => {
  async function frameOf(group: WorktreeGroup): Promise<string> {
    const setup = await testRender(
      <box flexDirection="column" width={100} height={3}>
        <WorktreeGroupHeader group={group} />
      </box>,
      { width: 100, height: 3 },
    );
    try {
      await setup.flush();
      return setup.captureCharFrame();
    } finally {
      setup.renderer.destroy();
    }
  }

  const HERE: WorktreeGroup = {
    kind: EWorkspaceKind.inPlace,
    glyph: '⌂',
    label: 'main · here',
    path: '/repo',
    branch: 'main',
    here: true,
    jobCount: 2,
  };

  it('names the main worktree as where you are standing', async () => {
    const frame = await frameOf(HERE);
    expect(frame).toContain('main · here');
    expect(frame).not.toContain('no jobs');
  });

  // A project whose every job took a worktree is working exactly as designed. `no jobs` under the
  // heading that names where you are standing would read as a problem instead of a fact.
  it('stays silent about an empty MAIN worktree, whose emptiness is not a leak', async () => {
    expect(await frameOf({ ...HERE, jobCount: 0 })).not.toContain('no jobs');
  });

  it('says `no jobs` for a linked worktree nothing is working in — the whole reason it is listed', async () => {
    expect(
      await frameOf({
        ...HERE,
        kind: EWorkspaceKind.worktree,
        glyph: '⑂',
        label: 'atlas/drain-abcdef12',
        branch: 'atlas/drain-abcdef12',
        here: false,
        jobCount: 0,
      }),
    ).toContain('no jobs');
  });

  it('names a missing worktree by the path it is missing from', async () => {
    expect(
      await frameOf({
        ...HERE,
        kind: EWorkspaceKind.missing,
        glyph: '⚠',
        label: 'worktree missing: /repo/.worktrees/gone',
        branch: null,
        here: false,
      }),
    ).toContain('/repo/.worktrees/gone');
  });
});
