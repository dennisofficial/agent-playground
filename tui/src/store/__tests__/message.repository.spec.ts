import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { EHarnessVariant } from '../../domain/message.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import {
  EEngine,
  EMessageType,
  EPhaseKind,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import { MessageRepository } from '../message.repository.js';
import { MigratorService } from '../migrator.service.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * A harness message has to survive a restart, and "restart" means the row is read back by a process
 * that has none of the objects that wrote it. So this runs against a real (temporary) SQLite file:
 * the claim is about what SQLite stored and what `asMessagePayload` makes of it coming back, and a
 * fake repository would only prove that an object handed to it is the object handed back.
 */
describe('MessageRepository', () => {
  let dir: string;
  let client: PrismaClient;
  let messageRepository: MessageRepository;
  let threadId: string;
  let sessionId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-messages-'));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);

    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    messageRepository = new MessageRepository(client as unknown as PrismaService);

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    const job = await client.job.create({ data: { projectId: project.id, title: 'a job' } });
    const phase = await client.phase.create({
      data: { jobId: job.id, kind: EPhaseKind.intake, ordinal: 0 },
    });
    const thread = await client.thread.create({
      data: { phaseId: phase.id, role: EThreadRole.intake },
    });
    const account = await client.account.create({
      data: { engine: EEngine.claude, label: 'dennis', materialEnc: 'x' },
    });
    const session = await client.engineSession.create({
      data: {
        threadId: thread.id,
        ordinal: 0,
        accountId: account.id,
        engine: EEngine.claude,
        model: 'claude-opus-5',
      },
    });
    threadId = thread.id;
    sessionId = session.id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a harness message back whole, variant included', async () => {
    await messageRepository.append({
      threadId,
      sessionId,
      payload: {
        type: EMessageType.harness,
        variant: EHarnessVariant.handoff,
        text: 'the previous leg stopped at the migration',
      },
    });

    const [message] = await messageRepository.listForThread(threadId);
    expect(message?.payload).toEqual({
      type: EMessageType.harness,
      variant: EHarnessVariant.handoff,
      text: 'the previous leg stopped at the migration',
    });
  });

  it('stamps the type on the column too, so a harness message is findable without parsing JSON', async () => {
    await messageRepository.append({
      threadId,
      sessionId,
      payload: { type: EMessageType.user, text: 'fix the drain' },
    });
    await messageRepository.append({
      threadId,
      sessionId,
      payload: {
        type: EMessageType.harness,
        variant: EHarnessVariant.seed,
        text: 'chart the fog',
      },
    });

    const rows = await client.threadMessage.findMany({
      where: { threadId },
      orderBy: { ordinal: 'asc' },
    });
    expect(rows.map((row) => row.type)).toEqual([EMessageType.user, EMessageType.harness]);
  });
});
