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
import { JobListRow } from '../components/job-list.js';
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
    role: EThreadRole.intake,
    status: EThreadStatus.closed,
    phaseId: 'p1',
    phaseKind: EPhaseKind.intake,
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
  title: 'add rotation nudges',
  activeThreadId: 't1',
  archivedAt: null,
  branch: null,
  workspacePath: null,
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
