import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { PrismaClient } from '../../generated/prisma/client.js';
import {
  EEngine,
  EPhaseKind,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import { AccountRepository } from '../account.repository.js';
import { MigratorService } from '../migrator.service.js';
import type { PrismaService } from '../prisma.service.js';

/**
 * Forgetting a credential is an AUTH operation, and these are claims about the database rather than
 * about a service: that the foreign key lets the row go, and that a session which ran on it survives
 * with its account cleared.
 *
 * It used to be `RESTRICT`, so an account became undeletable the moment it ran one turn — in defence
 * of a "who paid for this" record that rotation overwrites and nothing reads. The repository grew a
 * guard that turned the raw foreign-key error into advice to re-add the account instead.
 */
describe('AccountRepository.remove', () => {
  let dir: string;
  let client: PrismaClient;
  let accountRepository: AccountRepository;
  let threadId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-accounts-'));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);

    client = new PrismaClient({
      adapter: new PrismaBunSqlite({ url: `file:${database}` }),
    });
    accountRepository = new AccountRepository(client as unknown as PrismaService);

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    const job = await client.job.create({ data: { projectId: project.id, title: 'a job' } });
    const phase = await client.phase.create({
      data: { jobId: job.id, kind: EPhaseKind.build, ordinal: 0 },
    });
    const thread = await client.thread.create({
      data: { phaseId: phase.id, role: EThreadRole.builder },
    });
    threadId = thread.id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  async function account(email: string): Promise<string> {
    const row = await accountRepository.upsert({
      engine: EEngine.claude,
      label: email,
      accountEmail: email,
      subscriptionType: 'max',
      materialEnc: 'iv.tag.ct',
      expiresAt: null,
    });
    return row.id;
  }

  it('forgets an account that has never run anything', async () => {
    const id = await account('fresh@example.com');

    await accountRepository.remove(id);

    expect(await accountRepository.findById(id)).toBeNull();
  });

  it('forgets an account that HAS run sessions, and keeps the sessions', async () => {
    const id = await account('used@example.com');
    const session = await client.engineSession.create({
      data: {
        threadId,
        ordinal: 1,
        accountId: id,
        engine: EEngine.claude,
        model: 'claude-opus-5',
      },
    });

    await accountRepository.remove(id);

    expect(await accountRepository.findById(id)).toBeNull();
    // The work outlives the credential: the transcript, the resume id and the ledger all survive, and
    // only the pointer to "which account is this on" is cleared. The next turn resolves a new one.
    const after = await client.engineSession.findUnique({ where: { id: session.id } });
    expect(after?.accountId).toBeNull();
    expect(after?.model).toBe('claude-opus-5');
  });

  it('leaves other accounts’ sessions pointing where they were', async () => {
    const doomed = await account('doomed@example.com');
    const keeper = await account('keeper@example.com');
    const theirs = await client.engineSession.create({
      data: {
        threadId,
        ordinal: 1,
        accountId: keeper,
        engine: EEngine.claude,
        model: 'claude-opus-5',
      },
    });

    await accountRepository.remove(doomed);

    const after = await client.engineSession.findUnique({ where: { id: theirs.id } });
    expect(after?.accountId).toBe(keeper);
  });
});
