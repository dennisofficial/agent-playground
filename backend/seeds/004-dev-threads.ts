import type { Seeder } from '@workspace/nestjs-core';
import {
  EJobKind,
  EJobStatus,
  EMessageAudience,
  ETaskStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadMessageKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
} from '@workspace/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from '../src/_lib/database/entities/job.entity';
import { Repo } from '../src/_lib/database/entities/repo.entity';
import { Task } from '../src/_lib/database/entities/task.entity';
import { ThreadGroup } from '../src/_lib/database/entities/thread-group.entity';
import { ThreadMessage } from '../src/_lib/database/entities/thread-message.entity';
import { Thread } from '../src/_lib/database/entities/thread.entity';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

interface FxJob {
  id: string;
  title: string | null;
  origin: EThreadOrigin;
  kind: EJobKind | null;
  status: EJobStatus;
  archivedAt: string | null;
  focusedThreadId: string | null;
  createdAt: string;
}
interface FxGroup {
  id: string;
  ordinal: number;
  kind: EThreadGroupKind;
  title: string | null;
  type: string | null;
  status: EThreadStatus;
  condition: EThreadCondition;
  createdAt: string;
}
interface FxThread {
  id: string;
  threadGroupId: string;
  role: EThreadRole;
  type: EThreadType;
  parentThreadId: string | null;
  ordinal: number;
  brief: string | null;
  status: EThreadStatus;
  condition: EThreadCondition;
  sessionId: string | null;
  createdAt: string;
}
interface FxTask {
  id: string;
  threadGroupId: string;
  ordinal: number;
  title: string;
  brief: string | null;
  activeForm: string | null;
  status: ETaskStatus;
  blockedBy: string[];
  createdAt: string;
}
interface FxMsg {
  id: string;
  threadId: string;
  subagentId: string | null;
  source: EThreadMessageSource;
  audience?: EMessageAudience;
  author: string;
  authorId: string;
  text: string;
  kind: EThreadMessageKind;
  createdAt: string;
}
interface JobTree {
  job: FxJob;
  groups: FxGroup[];
  threads: FxThread[];
  tasks: FxTask[];
  messages: FxMsg[];
}
interface Fx {
  jobs: JobTree[];
}

export default (async (ds) => {
  const orgId = DEV_SEED_IDS.orgs.atlasTest;
  const repoId = DEV_SEED_IDS.repos.fixtures;
  const dennis = DEV_SEED_IDS.users.dennis;

  const fx = JSON.parse(
    readFileSync(join(__dirname, '_data', 'prod-threads.fixture.json'), 'utf8'),
  ) as Fx;

  const jobs = ds.getRepository(Job);
  const groupsRepo = ds.getRepository(ThreadGroup);
  const threadsRepo = ds.getRepository(Thread);
  const tasksRepo = ds.getRepository(Task);
  const messagesRepo = ds.getRepository(ThreadMessage);

  // One-time cleanup: drop the superseded synthesized magic-link fixture (cascades its whole tree).
  await jobs.delete({ id: '297a7963-c02b-4c7b-bf04-9720d0b79242' });

  let threadTotal = 0;

  for (const tree of fx.jobs) {
    const JOB = tree.job.id;

    // Job (focusedThreadId set after threads exist so the FK is satisfied).
    await jobs.save(
      jobs.create({
        id: JOB,
        orgId,
        repoId,
        focusedThreadId: null,
        title: tree.job.title,
        origin: tree.job.origin,
        kind: tree.job.kind,
        status: tree.job.status,
        archivedAt: tree.job.archivedAt ? new Date(tree.job.archivedAt) : null,
        createdAt: new Date(tree.job.createdAt),
      }),
    );

    await groupsRepo.save(
      tree.groups.map((g) =>
        groupsRepo.create({
          id: g.id,
          jobId: JOB,
          orgId,
          ordinal: g.ordinal,
          kind: g.kind,
          title: g.title,
          type: g.type,
          status: g.status,
          condition: g.condition,
          createdAt: new Date(g.createdAt),
        }),
      ),
    );

    await threadsRepo.save(
      tree.threads.map((t) =>
        threadsRepo.create({
          id: t.id,
          jobId: JOB,
          threadGroupId: t.threadGroupId,
          orgId,
          role: t.role,
          type: t.type,
          parentThreadId: t.parentThreadId,
          ordinal: t.ordinal,
          brief: t.brief ?? '',
          status: t.status,
          condition: t.condition,
          sessionId: t.sessionId,
          createdAt: new Date(t.createdAt),
        }),
      ),
    );

    if (tree.job.focusedThreadId)
      await jobs.update(JOB, { focusedThreadId: tree.job.focusedThreadId });

    await tasksRepo.save(
      tree.tasks.map((k) =>
        tasksRepo.create({
          id: k.id,
          jobId: JOB,
          threadGroupId: k.threadGroupId,
          orgId,
          ordinal: k.ordinal,
          title: k.title,
          brief: k.brief,
          activeForm: k.activeForm,
          status: k.status,
          blockedBy: k.blockedBy ?? [],
          createdAt: new Date(k.createdAt),
        }),
      ),
    );

    await messagesRepo.save(
      tree.messages.map((m) =>
        messagesRepo.create({
          id: m.id,
          jobId: JOB,
          threadId: m.threadId,
          orgId,
          subagentId: null,
          source: m.source,
          audience: m.audience ?? EMessageAudience.SHARED,
          authorId: m.authorId === '__DEV_USER__' ? dennis : m.authorId,
          author: m.author,
          text: m.text,
          kind: m.kind,
          card: null,
          meta: null,
          orderAt: null,
          createdAt: new Date(m.createdAt),
        }),
      ),
    );

    threadTotal += tree.threads.length;
  }

  // Keep the fixtures repo row self-consistent (denormalized thread counter).
  await ds.getRepository(Repo).update({ id: repoId }, { threadCount: threadTotal });

  console.log(`  004: upserted ${fx.jobs.length} prod jobs (${threadTotal} threads total)`);
}) satisfies Seeder;
