import type { EnvService } from '@core/config/env/env.service';
import type { Repository } from 'typeorm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpServerEntity } from '../../persistence/entities';
import { McpOAuthService } from '../mcp-oauth.service';
import { McpResolver } from '../mcp-resolver.service';
import { McpServerStore } from '../mcp-server.store';

const KEY = 'b'.repeat(64);

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
  async delete(): Promise<void> {}
  private match(r: McpServerEntity, where: Partial<McpServerEntity>): boolean {
    return Object.entries(where).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
    );
  }
}

function make(): { resolver: McpResolver; store: McpServerStore } {
  const repo = new FakeRepo();
  const env = {
    get: (k: string) => (k === 'SECRETS_ENCRYPTION_KEY' ? KEY : undefined),
  } as EnvService;
  const store = new McpServerStore(repo as unknown as Repository<McpServerEntity>, env);
  const oauth = new McpOAuthService(store, env);
  return { resolver: new McpResolver(store, oauth), store };
}

describe('McpResolver.resolveForTurn', () => {
  let resolver: McpResolver;
  let store: McpServerStore;
  beforeEach(() => {
    ({ resolver, store } = make());
  });

  it('returns [] when the org has no servers', async () => {
    expect(await resolver.resolveForTurn('org1', 'repo-1', 'brain')).toEqual([]);
  });

  it('a repo-scoped server OVERRIDES an org-scoped server of the same name', async () => {
    await store.write('org1', '*', 'search', {
      transport: 'http',
      url: 'https://org-endpoint',
    });
    await store.write('org1', 'repo-1', 'search', {
      transport: 'http',
      url: 'https://repo-endpoint',
    });
    const out = await resolver.resolveForTurn('org1', 'repo-1', 'brain');
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://repo-endpoint');
  });

  it('org-scoped servers apply to a repo that has no override of that name', async () => {
    await store.write('org1', '*', 'shared', {
      transport: 'http',
      url: 'https://shared',
    });
    const out = await resolver.resolveForTurn('org1', 'repo-9', 'build');
    expect(out.map((s) => s.name)).toEqual(['shared']);
  });

  it('filters by surface', async () => {
    await store.write('org1', '*', 'buildonly', {
      transport: 'http',
      url: 'https://x',
      surfaces: ['build'],
    });
    expect(await resolver.resolveForTurn('org1', 'repo-1', 'brain')).toEqual([]);
    expect((await resolver.resolveForTurn('org1', 'repo-1', 'build')).map((s) => s.name)).toEqual([
      'buildonly',
    ]);
  });

  it('excludes disabled servers', async () => {
    await store.write('org1', '*', 'off', {
      transport: 'http',
      url: 'https://x',
      enabled: false,
    });
    expect(await resolver.resolveForTurn('org1', 'repo-1', 'brain')).toEqual([]);
  });

  it('inlines decrypted secret header values for a remote server', async () => {
    await store.write('org1', '*', 'linear', {
      transport: 'http',
      url: 'https://mcp.linear.app',
      headers: [
        { name: 'Authorization', value: 'Bearer sk-123', secret: true },
        { name: 'X-Env', value: 'prod' },
      ],
    });
    const [s] = await resolver.resolveForTurn('org1', 'repo-1', 'brain');
    expect(s.headers).toEqual({
      Authorization: 'Bearer sk-123',
      'X-Env': 'prod',
    });
    expect(s.transport).toBe('http');
    expect(s.command).toBeUndefined();
  });

  it('inlines the OAuth access token as a Bearer header for an oauth server', async () => {
    await store.write('org1', '*', 'jira', {
      transport: 'sse',
      url: 'https://mcp.atlassian.com/v1/sse',
      authKind: 'oauth',
    });
    await store.writeOAuthBlob('org1', '*', 'jira', {
      tokens: { access_token: 'at-xyz', refresh_token: 'rt', expires_in: 3600 },
      obtainedAt: Date.now(),
    });
    const [s] = await resolver.resolveForTurn('org1', 'repo-1', 'brain');
    expect(s.transport).toBe('sse');
    expect(s.headers).toEqual({ Authorization: 'Bearer at-xyz' });
  });

  it('omits the Authorization header for an oauth server that is not yet connected', async () => {
    await store.write('org1', '*', 'jira2', {
      transport: 'sse',
      url: 'https://mcp.atlassian.com/v1/sse',
      authKind: 'oauth',
    });
    const [s] = await resolver.resolveForTurn('org1', 'repo-1', 'brain');
    expect(s.headers).toBeUndefined();
  });

  it('inlines decrypted secret env values for a stdio server', async () => {
    await store.write('org1', '*', 'db', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'db-mcp'],
      env: [{ name: 'DB_URL', value: 'postgres://secret', secret: true }],
    });
    const [s] = await resolver.resolveForTurn('org1', 'repo-1', 'build');
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', 'db-mcp']);
    expect(s.env).toEqual({ DB_URL: 'postgres://secret' });
    expect(s.url).toBeUndefined();
  });
});
