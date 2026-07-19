import type { Seeder } from '@workspace/nestjs-core';
import {
  EJobActivity,
  EJobKind,
  EJobStatus,
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
import { Job } from '../src/app/job/entities/job.entity';
import { Task } from '../src/app/job/entities/task.entity';
import { ThreadGroup } from '../src/app/job/entities/thread-group.entity';
import { ThreadMessage } from '../src/app/job/entities/thread-message.entity';
import { Thread } from '../src/app/job/entities/thread.entity';
import { Repo } from '../src/app/repo/entities/repo.entity';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';

/**
 * A REAL (sanitized) job tree on the FIXTURES repo (`atlas-dev/fixtures`) so the workspace UI has
 * authentic content — sidebar navigator (7 thread groups), lanes (planning / plan_review / builders /
 * review agents / master_review), a real transcript, and the agent task list. Dumped from prod (the
 * `Custom Codex SDK` job), mapped old→new schema (author→source, old kinds→`EThreadMessageKind`, ids
 * remapped to the fixtures org/repo, operator identity → the dev user, secrets/PII redacted). The data
 * lives in `_data/codex-sdk.fixture.json`.
 *
 * UPSERT + ADDITIVE: rows keep their original prod uuids and are `save()`d (insert-or-update by PK), so
 * re-running `pnpm db:seed` re-applies changes without duplicating and never touches the real repo.
 */

interface FxJob {
  id: string;
  title: string | null;
  origin: EThreadOrigin;
  kind: EJobKind | null;
  status: EJobStatus;
  activity: EJobActivity;
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
  author: string;
  authorId: string;
  text: string;
  kind: EThreadMessageKind;
  createdAt: string;
}
interface Fx {
  job: FxJob;
  groups: FxGroup[];
  threads: FxThread[];
  tasks: FxTask[];
  messages: FxMsg[];
}

export default (async (ds) => {
  const orgId = DEV_SEED_IDS.orgs.atlasTest;
  const repoId = DEV_SEED_IDS.repos.fixtures;
  const dennis = DEV_SEED_IDS.users.dennis;

  const fx = JSON.parse(
    readFileSync(join(__dirname, '_data', 'codex-sdk.fixture.json'), 'utf8'),
  ) as Fx;

  const jobs = ds.getRepository(Job);
  const groupsRepo = ds.getRepository(ThreadGroup);
  const threadsRepo = ds.getRepository(Thread);
  const tasksRepo = ds.getRepository(Task);
  const messagesRepo = ds.getRepository(ThreadMessage);
  const JOB = fx.job.id;

  // One-time cleanup: drop the superseded synthesized magic-link fixture (cascades its whole tree).
  // No-op once it's gone.
  await jobs.delete({ id: '297a7963-c02b-4c7b-bf04-9720d0b79242' });

  // ── Job (focusedThreadId set after threads exist so the FK is satisfied) ──
  await jobs.save(
    jobs.create({
      id: JOB,
      orgId,
      repoId,
      focusedThreadId: null,
      title: fx.job.title,
      origin: fx.job.origin,
      kind: fx.job.kind,
      status: fx.job.status,
      activity: fx.job.activity,
      createdAt: new Date(fx.job.createdAt),
    }),
  );

  // ── Thread groups (the navigator items) ──
  await groupsRepo.save(
    fx.groups.map((g) =>
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

  // ── Threads (lanes) ──
  await threadsRepo.save(
    fx.threads.map((t) =>
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

  // Focus the job's planning thread (what a job click routes to by default) — now that it exists.
  if (fx.job.focusedThreadId) await jobs.update(JOB, { focusedThreadId: fx.job.focusedThreadId });

  // ── Agent tasks ──
  await tasksRepo.save(
    fx.tasks.map((k) =>
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

  // ── Transcript (real, sanitized) — operator identity remapped to the dev user ──
  await messagesRepo.save(
    fx.messages.map((m) =>
      messagesRepo.create({
        id: m.id,
        jobId: JOB,
        threadId: m.threadId,
        orgId,
        subagentId: null,
        source: m.source,
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

  // Keep the fixtures repo row self-consistent (denormalized thread counter).
  await ds.getRepository(Repo).update({ id: repoId }, { threadCount: fx.threads.length });

  console.log(
    `  003: upserted "${fx.job.title}" (${fx.groups.length} groups, ${fx.threads.length} threads, ${fx.messages.length} messages, ${fx.tasks.length} tasks)`,
  );
}) satisfies Seeder;
