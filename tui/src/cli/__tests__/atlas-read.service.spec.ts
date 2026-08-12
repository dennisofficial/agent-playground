import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { PrismaClient } from '../../generated/prisma/client.js';
import {
  EEngine,
  EMessageType,
  EPhaseKind,
  ESessionEndReason,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import { EClaudeEffort } from '../../domain/role-engine.js';
import { JobRepository } from '../../store/job.repository.js';
import { MessageRepository } from '../../store/message.repository.js';
import { MigratorService } from '../../store/migrator.service.js';
import type { PrismaService } from '../../store/prisma.service.js';
import { SessionRepository } from '../../store/session.repository.js';
import { ThreadRepository } from '../../store/thread.repository.js';
import { AtlasReadService } from '../atlas-read.service.js';
import { ECliCommand } from '../invocation.js';

/**
 * Against a real (temporary) SQLite file rather than fake repositories: what is under test is that
 * the CLI reads the SAME normalised store the TUI does, and a fake would only prove the fake agrees
 * with itself. `PrismaService` is `PrismaClient` plus a hardcoded path and a Nest lifecycle, neither
 * of which the repositories use, so a bare client stands in for it.
 */
describe('AtlasReadService', () => {
  let dir: string;
  let client: PrismaClient;
  let service: AtlasReadService;
  let jobId: string;
  let threadId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);

    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    const prismaService = client as unknown as PrismaService;
    const jobRepository = new JobRepository(prismaService);
    const threadRepository = new ThreadRepository(prismaService);
    const sessionRepository = new SessionRepository(prismaService);
    const messageRepository = new MessageRepository(prismaService);
    service = new AtlasReadService(
      jobRepository,
      threadRepository,
      sessionRepository,
      messageRepository,
    );

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    const job = await jobRepository.create({
      projectId: project.id,
      title: 'ship the CLI',
      kind: EPhaseKind.intake,
    });
    jobId = job.id;

    const phase = await jobRepository.currentPhase(jobId);
    const thread = await threadRepository.create({ phaseId: phase.id, role: EThreadRole.intake });
    threadId = thread.id;

    const account = await client.account.create({
      data: { engine: EEngine.claude, label: 'test', materialEnc: 'x' },
    });
    const first = await sessionRepository.open({
      threadId,
      accountId: account.id,
      engineConfig: { kind: EEngine.claude, model: 'sonnet', effort: EClaudeEffort.high },
    });
    await messageRepository.append({
      threadId,
      sessionId: first.id,
      payload: { type: EMessageType.user, text: 'why postgres?' },
    });
    await sessionRepository.end(first.id, ESessionEndReason.context_pressure);

    const second = await sessionRepository.open({
      threadId,
      accountId: account.id,
      engineConfig: { kind: EEngine.claude, model: 'sonnet', effort: EClaudeEffort.high },
    });
    await messageRepository.append({
      threadId,
      sessionId: second.id,
      payload: { type: EMessageType.assistant, text: 'because of the RLS story' },
    });
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the job as phases -> threads -> sessions', async () => {
    const result = await service.run({ name: ECliCommand.threads, jobId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain(`job ${jobId}  ship the CLI`);
    expect(result.text).toContain('phase intake  (current)');
    expect(result.text).toContain(`thread ${threadId}`);
    expect(result.text).toContain('messages=2');
    expect(result.text).toContain('session 1  ended=context_pressure');
    expect(result.text).toContain('session 2  open');
  });

  it('reads a transcript from the normalised store, across the rotation', async () => {
    const result = await service.run({ name: ECliCommand.transcript, threadId, full: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.text).toContain('why postgres?');
    expect(result.text).toContain('because of the RLS story');
    // Thread-scoped ordinals, so the second session continues the numbering.
    expect(result.text).toContain('--- [0] user');
    expect(result.text).toContain('--- [1] assistant');
    expect(result.text).toContain('=== session 2 begins — previous session ended: context_pressure');
  });

  it('fails a missing job with a usable message rather than a stack trace', async () => {
    for (const command of [
      { name: ECliCommand.threads, jobId: 'nope' } as const,
      { name: ECliCommand.map, jobId: 'nope' } as const,
      { name: ECliCommand.ticket, jobId: 'nope', ticketNumber: 1 } as const,
    ]) {
      const result = await service.run(command);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('job nope not found');
      expect(result.message).toContain('--job');
    }
  });

  it('fails a missing thread with the command that would list the real ones', async () => {
    const result = await service.run({
      name: ECliCommand.transcript,
      threadId: 'nope',
      full: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('thread nope not found');
    expect(result.message).toContain('atlas threads');
  });

  it('checks the job exists BEFORE its folder, so a typo is not read as "no map yet"', async () => {
    const result = await service.run({ name: ECliCommand.map, jobId: 'typo' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('intake writes');
  });
});
