import {
  EJobKind,
  EJobStatus,
  EMessageAudience,
  EThreadCondition,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadOutputType,
  EThreadRole,
  EThreadStatus,
  EThreadType,
  ETaskStatus,
  type EThreadMessageType,
} from '@workspace/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '../src/generated/prisma/client';
import { DEV_SEED_IDS } from './_shared/dev-seed-ids';
import type { Seeder } from './_shared/seeder';

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
  /** Fixture-era coarse kind — mapped to the current {@link EThreadMessageType} below; `author` is
   *  dropped, the schema only keeps `authorId` now. */
  kind: string;
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

/** Maps the fixture's pre-taxonomy `kind` strings onto the current, single-source `EThreadMessageType`. */
function mapMessageType(kind: string): EThreadMessageType {
  switch (kind) {
    case 'chat':
      return EThreadOutputType.CHAT;
    case 'thinking':
      return EThreadOutputType.THINKING;
    case 'tool':
      return EThreadOutputType.TOOL;
    case 'build_event':
      return EThreadOutputType.EVENT;
    default:
      throw new Error(`004: unmapped fixture message kind "${kind}"`);
  }
}

export default (async (prisma) => {
  const orgId = DEV_SEED_IDS.orgs.atlasTest;
  const repoId = DEV_SEED_IDS.repos.fixtures;
  const dennis = DEV_SEED_IDS.users.dennis;

  const fx = JSON.parse(
    readFileSync(join(__dirname, '_data', 'prod-threads.fixture.json'), 'utf8'),
  ) as Fx;

  // One-time cleanup: drop the superseded synthesized magic-link fixture (cascades its whole tree).
  // `deleteMany` (not `delete`), so a re-run after the row is already gone stays a no-op instead of
  // throwing "record not found".
  await prisma.job.deleteMany({ where: { id: '297a7963-c02b-4c7b-bf04-9720d0b79242' } });

  let threadTotal = 0;

  for (const tree of fx.jobs) {
    const JOB = tree.job.id;

    // Job (focusedThreadId set after threads exist so the FK is satisfied).
    const jobFields = {
      title: tree.job.title,
      origin: tree.job.origin,
      kind: tree.job.kind,
      status: tree.job.status,
      archivedAt: tree.job.archivedAt ? new Date(tree.job.archivedAt) : null,
      createdAt: new Date(tree.job.createdAt),
    };
    await prisma.job.upsert({
      where: { id: JOB },
      create: { id: JOB, orgId, repoId, focusedThreadId: null, ...jobFields },
      update: jobFields,
    });

    await Promise.all(
      tree.groups.map((g) => {
        const fields = {
          ordinal: g.ordinal,
          kind: g.kind,
          title: g.title,
          type: g.type,
          status: g.status,
          condition: g.condition,
          createdAt: new Date(g.createdAt),
        };
        return prisma.threadGroup.upsert({
          where: { id: g.id },
          create: { id: g.id, jobId: JOB, orgId, ...fields },
          update: fields,
        });
      }),
    );

    await Promise.all(
      tree.threads.map((t) => {
        const fields = {
          threadGroupId: t.threadGroupId,
          role: t.role,
          type: t.type,
          parentThreadId: t.parentThreadId,
          ordinal: t.ordinal,
          brief: t.brief ?? '',
          status: t.status,
          condition: t.condition,
          sessionId: t.sessionId,
          createdAt: new Date(t.createdAt),
        };
        return prisma.thread.upsert({
          where: { id: t.id },
          create: { id: t.id, jobId: JOB, orgId, ...fields },
          update: fields,
        });
      }),
    );

    if (tree.job.focusedThreadId)
      await prisma.job.update({
        where: { id: JOB },
        data: { focusedThreadId: tree.job.focusedThreadId },
      });

    await Promise.all(
      tree.tasks.map((k) => {
        const fields = {
          threadGroupId: k.threadGroupId,
          ordinal: k.ordinal,
          title: k.title,
          brief: k.brief,
          activeForm: k.activeForm,
          status: k.status,
          blockedBy: k.blockedBy ?? [],
          createdAt: new Date(k.createdAt),
        };
        return prisma.task.upsert({
          where: { id: k.id },
          create: { id: k.id, jobId: JOB, orgId, ...fields },
          update: fields,
        });
      }),
    );

    await Promise.all(
      tree.messages.map((m) => {
        const fields = {
          threadId: m.threadId,
          subagentId: null,
          source: m.source,
          audience: m.audience ?? EMessageAudience.SHARED,
          authorId: m.authorId === '__DEV_USER__' ? dennis : m.authorId,
          text: m.text,
          type: mapMessageType(m.kind),
          card: Prisma.JsonNull,
          meta: Prisma.JsonNull,
          orderAt: null,
          createdAt: new Date(m.createdAt),
        };
        return prisma.threadMessage.upsert({
          where: { id: m.id },
          create: { id: m.id, jobId: JOB, orgId, ...fields },
          update: fields,
        });
      }),
    );

    threadTotal += tree.threads.length;
  }

  // Keep the fixtures repo row self-consistent (denormalized thread counter).
  await prisma.repo.update({ where: { id: repoId }, data: { threadCount: threadTotal } });

  console.log(`  004: upserted ${fx.jobs.length} prod jobs (${threadTotal} threads total)`);
}) satisfies Seeder;
