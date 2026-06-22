import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import type { AtlasSlackInstallation } from '../persistence/entities';
import { SlackInstallationStore } from './slack-installation.store';

const KEY = Buffer.alloc(32, 5).toString('base64');

function fakeEnv(map: Record<string, string | undefined> = { SECRETS_ENCRYPTION_KEY: KEY }): EnvService {
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

function fakeRepo(): Repository<AtlasSlackInstallation> {
  const rows = new Map<string, AtlasSlackInstallation>();
  return {
    async findOne({ where }: { where: { team_id: string } }) {
      return rows.get(where.team_id) ?? null;
    },
    create(p: Partial<AtlasSlackInstallation>) {
      return { ...p } as AtlasSlackInstallation;
    },
    async save(row: AtlasSlackInstallation) {
      rows.set(row.team_id, row);
      return row;
    },
    async update({ team_id }: { team_id: string }, patch: Partial<AtlasSlackInstallation>) {
      const prev = rows.get(team_id);
      if (prev) rows.set(team_id, { ...prev, ...patch });
    },
  } as unknown as Repository<AtlasSlackInstallation>;
}

describe('SlackInstallationStore', () => {
  it('encrypts the bot token at rest and decrypts on read', async () => {
    const repo = fakeRepo();
    const store = new SlackInstallationStore(repo, fakeEnv());
    await store.upsert({ teamId: 'T1', botToken: 'xoxb-secret', botUserId: 'UBOT', scopes: 'chat:write' });

    const row = await repo.findOne({ where: { team_id: 'T1' } });
    expect(row?.bot_token_enc).toBeTruthy();
    expect(row?.bot_token_enc).not.toContain('xoxb-secret'); // ciphertext

    expect(await store.botToken('T1')).toBe('xoxb-secret');
    expect(await store.botUserId('T1')).toBe('UBOT');
  });

  it('returns undefined for an unknown team', async () => {
    const store = new SlackInstallationStore(fakeRepo(), fakeEnv());
    expect(await store.botToken('nope')).toBeUndefined();
  });

  it('stops returning a token after uninstall (soft-delete)', async () => {
    const store = new SlackInstallationStore(fakeRepo(), fakeEnv());
    await store.upsert({ teamId: 'T1', botToken: 'xoxb-1' });
    expect(await store.botToken('T1')).toBe('xoxb-1');
    await store.markUninstalled('T1');
    expect(await store.botToken('T1')).toBeUndefined();
  });

  it('refreshes the token on re-install (cache invalidated)', async () => {
    const store = new SlackInstallationStore(fakeRepo(), fakeEnv());
    await store.upsert({ teamId: 'T1', botToken: 'xoxb-1' });
    expect(await store.botToken('T1')).toBe('xoxb-1');
    await store.upsert({ teamId: 'T1', botToken: 'xoxb-2' });
    expect(await store.botToken('T1')).toBe('xoxb-2');
  });
});
