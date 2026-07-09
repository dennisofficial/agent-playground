import { describe, expect, it, beforeEach } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import type { McpServerEntity } from '../persistence/entities';
import { McpServerStore } from './mcp-server.store';

// A 32-byte key as 64 hex chars — the only shape `loadSecretsKey` accepts.
const KEY = 'a'.repeat(64);

/** Minimal in-memory stand-in for the TypeORM repository (only the methods the store calls). */
class FakeRepo {
  rows: McpServerEntity[] = [];
  create(p: Partial<McpServerEntity>): McpServerEntity {
    return { ...p } as McpServerEntity;
  }
  async save(row: McpServerEntity): Promise<McpServerEntity> {
    const i = this.rows.findIndex(
      (r) => r.org_id === row.org_id && r.scope === row.scope && r.name === row.name,
    );
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: { where: Partial<McpServerEntity> }): Promise<McpServerEntity | null> {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  async find({
    where,
  }: {
    where: Partial<McpServerEntity> | Partial<McpServerEntity>[];
  }): Promise<McpServerEntity[]> {
    const conds = Array.isArray(where) ? where : [where];
    return this.rows.filter((r) => conds.some((c) => this.match(r, c)));
  }
  async delete(where: Partial<McpServerEntity>): Promise<void> {
    this.rows = this.rows.filter((r) => !this.match(r, where));
  }
  private match(r: McpServerEntity, where: Partial<McpServerEntity>): boolean {
    return Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  }
}

function makeStore(): { store: McpServerStore; repo: FakeRepo } {
  const repo = new FakeRepo();
  const env = { get: (k: string) => (k === 'SECRETS_ENCRYPTION_KEY' ? KEY : undefined) } as EnvService;
  const store = new McpServerStore(repo as unknown as Repository<McpServerEntity>, env);
  return { store, repo };
}

describe('McpServerStore', () => {
  let store: McpServerStore;
  let repo: FakeRepo;
  beforeEach(() => {
    ({ store, repo } = makeStore());
  });

  it('maps the org-scope alias to the "*" sentinel and back', () => {
    expect(McpServerStore.toDbScope('org')).toBe('*');
    expect(McpServerStore.toDbScope('repo-1')).toBe('repo-1');
    expect(McpServerStore.fromDbScope('*')).toBe('org');
    expect(McpServerStore.fromDbScope('repo-1')).toBe('repo-1');
  });

  it('encrypts a secret header out of config and round-trips it', async () => {
    await store.write('org1', '*', 'linear', {
      transport: 'http',
      url: 'https://mcp.linear.app',
      headers: [{ name: 'Authorization', value: 'Bearer secret', secret: true }],
    });
    const row = repo.rows[0];
    // The secret value is NEVER in config — only a null placeholder.
    expect(row.config.headers).toEqual({ Authorization: null });
    expect(row.secrets_enc).toBeTruthy();
    expect(row.secrets_enc).not.toContain('secret');
    // But the store can decrypt it back.
    expect(store.decryptSecrets(row)).toEqual({ headers: { Authorization: 'Bearer secret' } });
  });

  it('keeps a non-secret header value inline in config', async () => {
    await store.write('org1', '*', 'svc', {
      transport: 'http',
      url: 'https://svc',
      headers: [{ name: 'X-Env', value: 'prod' }],
    });
    expect(repo.rows[0].config.headers).toEqual({ 'X-Env': 'prod' });
    expect(repo.rows[0].secrets_enc).toBeNull();
  });

  it('redacts on list — secret slots are null, secretKeys names them, no plaintext leaks', async () => {
    await store.write('org1', 'repo-1', 'db', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'db-mcp'],
      env: [{ name: 'DB_URL', value: 'postgres://secret', secret: true }],
      surfaces: ['build'],
    });
    const [server] = await store.list('org1');
    expect(server.scope).toBe('repo-1');
    expect(server.config.env).toEqual({ DB_URL: null });
    expect(server.secretKeys).toEqual(['env:DB_URL']);
    expect(JSON.stringify(server)).not.toContain('postgres://secret');
  });

  it('preserves a stored secret when a secret field is re-submitted EMPTY', async () => {
    await store.write('org1', '*', 'svc', {
      transport: 'http',
      url: 'https://svc',
      headers: [{ name: 'Authorization', value: 'tok-1', secret: true }],
    });
    // Edit: keep the header secret but submit an empty value (the console "re-enter to change" UX).
    await store.write('org1', '*', 'svc', {
      transport: 'http',
      url: 'https://svc/v2',
      headers: [{ name: 'Authorization', value: '', secret: true }],
    });
    const row = repo.rows[0];
    expect(row.config.url).toBe('https://svc/v2');
    expect(store.decryptSecrets(row)).toEqual({ headers: { Authorization: 'tok-1' } });
  });

  it('resets validation state on write', async () => {
    await store.write('org1', '*', 'svc', { transport: 'http', url: 'https://svc' });
    const row = repo.rows[0];
    row.discovered_tools = ['a'];
    row.last_validated_at = new Date();
    await store.write('org1', '*', 'svc', { transport: 'http', url: 'https://svc2' });
    expect(repo.rows[0].discovered_tools).toBeNull();
    expect(repo.rows[0].last_validated_at).toBeNull();
  });

  it('rowsForTurn returns org-scope + one repo scope only', async () => {
    await store.write('org1', '*', 'a', { transport: 'http', url: 'https://a' });
    await store.write('org1', 'repo-1', 'b', { transport: 'http', url: 'https://b' });
    await store.write('org1', 'repo-2', 'c', { transport: 'http', url: 'https://c' });
    const rows = await store.rowsForTurn('org1', 'repo-1');
    expect(rows.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('deletes a server', async () => {
    await store.write('org1', '*', 'gone', { transport: 'http', url: 'https://x' });
    await store.delete('org1', '*', 'gone');
    expect(repo.rows).toHaveLength(0);
  });

  describe('setSecret — single-slot read-modify-write (the provide-secret MCP lane)', () => {
    it('fills one empty placeholder slot without clobbering siblings, adds the config null placeholder', async () => {
      // A server registered by the approve endpoint: a secret header declared as an empty placeholder plus a
      // non-secret header inline.
      await store.write('org1', 'repo-1', 'github', {
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [
          { name: 'Authorization', value: '', secret: true },
          { name: 'X-Env', value: 'prod' },
        ],
      });
      const ok = await store.setSecret('org1', 'repo-1', 'github', 'headers', 'Authorization', 'Bearer ghp_x');
      expect(ok).toBe(true);
      const row = repo.rows[0];
      // The non-secret sibling is untouched; the secret slot stays a null placeholder in config.
      expect(row.config.headers).toEqual({ Authorization: null, 'X-Env': 'prod' });
      // The value round-trips out of the encrypted blob, and never appears in config/plaintext.
      expect(store.decryptSecrets(row)).toEqual({ headers: { Authorization: 'Bearer ghp_x' } });
      expect(JSON.stringify(row.config)).not.toContain('ghp_x');
    });

    it('adds a brand-new config placeholder when the key was not declared', async () => {
      await store.write('org1', 'repo-1', 'svc', { transport: 'stdio', command: 'npx' });
      const ok = await store.setSecret('org1', 'repo-1', 'svc', 'env', 'TOKEN', 't-1');
      expect(ok).toBe(true);
      expect(repo.rows[0].config.env).toEqual({ TOKEN: null });
      expect(store.decryptSecrets(repo.rows[0])).toEqual({ env: { TOKEN: 't-1' } });
    });

    it('preserves other already-set secrets on the same slot', async () => {
      await store.write('org1', 'repo-1', 'svc', {
        transport: 'http',
        url: 'https://svc',
        headers: [
          { name: 'A', value: 'a-1', secret: true },
          { name: 'B', value: '', secret: true },
        ],
      });
      await store.setSecret('org1', 'repo-1', 'svc', 'headers', 'B', 'b-1');
      expect(store.decryptSecrets(repo.rows[0])).toEqual({ headers: { A: 'a-1', B: 'b-1' } });
    });

    it('returns false (no throw) when the server row is gone', async () => {
      expect(await store.setSecret('org1', 'repo-1', 'missing', 'headers', 'X', 'v')).toBe(false);
    });
  });

  describe('unfilledSecretSlots', () => {
    it('reports a declared-but-empty secret slot as unfilled, by slot name only', async () => {
      await store.write('org1', 'repo-1', 'github', {
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [{ name: 'Authorization', value: '', secret: true }], // declared, no value
      });
      const gaps = await store.unfilledSecretSlots('org1', 'repo-1');
      expect(gaps).toEqual([{ name: 'github', scope: 'repo-1', slots: ['header:Authorization'] }]);
    });

    it('does not report a slot once its value is filled', async () => {
      await store.write('org1', 'repo-1', 'github', {
        transport: 'http',
        url: 'https://x',
        headers: [{ name: 'Authorization', value: 'Bearer tok', secret: true }],
      });
      expect(await store.unfilledSecretSlots('org1', 'repo-1')).toEqual([]);
    });

    it('ignores non-secret headers and disabled servers', async () => {
      await store.write('org1', 'repo-1', 'plain', {
        transport: 'http',
        url: 'https://x',
        headers: [{ name: 'X-Env', value: 'prod' }], // non-secret → never a gap
      });
      await store.write('org1', 'repo-1', 'off', {
        transport: 'http',
        url: 'https://x',
        headers: [{ name: 'Authorization', value: '', secret: true }],
        enabled: false,
      });
      expect(await store.unfilledSecretSlots('org1', 'repo-1')).toEqual([]);
    });
  });

  describe('authFailingServers', () => {
    it('reports an enabled server whose validation probe failed, with auth kind + reason (safe string only)', async () => {
      await store.write('org1', 'repo-1', 'github', {
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: [{ name: 'Authorization', value: 'Bearer ghp_expired', secret: true }],
      });
      await store.recordValidation('org1', 'repo-1', 'github', { error: '401 Unauthorized' });
      expect(await store.authFailingServers('org1', 'repo-1')).toEqual([
        { name: 'github', scope: 'repo-1', authKind: 'static', reason: '401 Unauthorized' },
      ]);
    });

    it('reports an OAuth server flagged for re-auth as authKind oauth', async () => {
      await store.write('org1', '*', 'jira', {
        transport: 'http',
        url: 'https://mcp.atlassian.com',
        authKind: 'oauth',
      });
      // McpOAuthService.markNeedsReauth writes this marker into validation_error on a dead refresh.
      await store.recordValidation('org1', '*', 'jira', { error: 'needs re-auth' });
      expect(await store.authFailingServers('org1', '*')).toEqual([
        { name: 'jira', scope: 'org', authKind: 'oauth', reason: 'needs re-auth' },
      ]);
    });

    it('does not report a healthy server (no validation_error)', async () => {
      await store.write('org1', 'repo-1', 'ok', {
        transport: 'http',
        url: 'https://x',
        headers: [{ name: 'Authorization', value: 'Bearer live', secret: true }],
      });
      await store.recordValidation('org1', 'repo-1', 'ok', { discoveredTools: ['t'] });
      expect(await store.authFailingServers('org1', 'repo-1')).toEqual([]);
    });

    it('skips a disabled server even when its auth is failing', async () => {
      await store.write('org1', 'repo-1', 'off', {
        transport: 'http',
        url: 'https://x',
        headers: [{ name: 'Authorization', value: 'Bearer x', secret: true }],
        enabled: false,
      });
      await store.recordValidation('org1', 'repo-1', 'off', { error: '401 Unauthorized' });
      expect(await store.authFailingServers('org1', 'repo-1')).toEqual([]);
    });
  });
});
