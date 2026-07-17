/**
 * `RedisEngineRunner` + REAL `ProfileAwarenessService` (live Postgres) — the full install-awareness
 * round-trip: a simulated in-container engine XADDs a `tool_request` for the reserved
 * `__profile_awareness` host tool, the runner dispatches it to the real service (backed by the
 * `profile_seen_tooling` ledger), and the reply flows back over the replies stream.
 *
 * Mirrors `profile-awareness.service.int.test.ts`'s DB bootstrap and
 * `redis-engine-runner.spec.ts`'s tool-bridge `fakeContainers`/`execDetached` pattern.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES } from '../../persistence/entities';
import { WorkspaceConfigStore } from '../../onboarding/workspace-config.store';
import { ProfileAwarenessService } from '../../workspace-profile/profile-awareness.service';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import { RedisEngineRunner } from '../redis-engine-runner';
import { turnKeys } from '../redis-turn-keys';
import type { EnvService } from '@core/config/env/env.service';
import type { SandboxActivityRegistry } from '../sandbox-activity.registry';
import type { TurnRegistry } from '../turn-registry.service';
import type { ContainerEngine } from '../container-engine.port';
import type {
  EngineEvent,
  RunEngineArgs,
  ToolBridgeOptions,
} from '@shared/engine/engine.types';
import { agentMessage } from '@shared/prompt-kit/message';

const ORG_ID = '3bbbbbbb-2222-4222-8222-222222222222';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

const fakeEnv = { get: () => undefined } as unknown as EnvService;
const fakeActivity = {
  thread: (_id: string, fn: () => unknown) => fn(),
} as unknown as SandboxActivityRegistry;

function fakeRegistry() {
  return {
    register: vi.fn(() => Promise.resolve(undefined)),
    heartbeat: vi.fn(() => Promise.resolve(undefined)),
    finalize: vi.fn(() => Promise.resolve(true)),
    getToolReply: vi.fn(() => Promise.resolve(null)),
    recordToolReply: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as TurnRegistry;
}

function baseArgs(onEvent: (e: EngineEvent) => void): RunEngineArgs {
  return {
    engine: 'claude',
    task: agentMessage('do the thing'),
    cwd: '/wt',
    systemPrompt: agentMessage('SYS'),
    sandboxKey: {
      orgId: ORG_ID,
      repoId: 'repo-1',
      jobId: 'job-1',
      type: 'build',
    },
    mode: 'execute',
    onEvent,
    target: { containerId: 'c1', worktreeHost: '/wt' },
  };
}

/**
 * A fake `ContainerEngine.execDetached` simulating the in-container entrypoint: XADDs a `tool_request`
 * for `__profile_awareness`, polls the replies stream for the correlated reply, then emits the reply's
 * result as a text event before ending the turn.
 */
function fakeContainersWithProfileAwarenessCall(
  redis: InMemoryRedisStream,
  command: string,
) {
  return {
    execDetached: vi.fn(
      (
        _id: string,
        _argv: string[],
        opts?: { env?: Record<string, string> },
      ) => {
        const turnId = opts?.env?.TURN_ID;
        if (!turnId) return Promise.resolve({});
        const k = turnKeys(turnId);
        void (async () => {
          const callId = `call-${turnId}`;
          await redis.xadd(k.tools, {
            t: 'tool_request',
            id: callId,
            name: '__profile_awareness',
            args: { command },
          });
          let lastId = '0-0';
          let done = false;
          for (let i = 0; i < 50 && !done; i++) {
            const r = await redis.xread({
              stream: k.replies,
              lastId,
              count: 10,
              blockMs: 50,
            });
            for (const entry of r) {
              const d = entry.data as {
                id?: string;
                t?: string;
                result?: unknown;
              };
              if (d.id !== callId) continue;
              if (d.t === 'tool_progress') continue;
              const text =
                d.t === 'tool_response' && typeof d.result === 'string'
                  ? d.result
                  : '';
              await redis.xadd(k.events, {
                t: 'event',
                e: { kind: 'text', text },
              });
              done = true;
              break;
            }
            if (r.length) lastId = r[r.length - 1].id;
          }
          await redis.xadd(k.events, { t: 'final', r: { result: 'DONE' } });
        })();
        return Promise.resolve({});
      },
    ),
  } as unknown as ContainerEngine;
}

describe('RedisEngineRunner + ProfileAwarenessService (live Postgres) — install-awareness round-trip', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let service: ProfileAwarenessService;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [WorkspaceConfigStore, ProfileAwarenessService],
    }).compile();

    service = mod.get(ProfileAwarenessService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Install Awareness Redis Org', 'install-awareness-redis-org', 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, 'install-awareness-redis-repo', 'Install Awareness Redis Repo', 'https://github.com/x/y.git', 'main', true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await ds
      ?.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID])
      .catch(() => undefined);
    await ds
      ?.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID])
      .catch(() => undefined);
    await mod?.close();
  });

  async function ledger(): Promise<
    Array<{ key: string; firstSeenAt: string }>
  > {
    const rows = await ds.query(
      `SELECT profile_seen_tooling AS t FROM repos WHERE id = $1`,
      [repoId],
    );
    return rows[0].t ?? [];
  }

  function makeBridge(): ToolBridgeOptions {
    return {
      jobId: 'job-1',
      tools: {
        __profile_awareness: (args: Record<string, unknown>) => {
          const commandArg = args.command;
          return service.handle({
            orgId: ORG_ID,
            repoId,
            jobId: 'job-1',
            sessionType: 'build',
            command: typeof commandArg === 'string' ? commandArg : '',
          });
        },
      },
    };
  }

  it('round-trips a real install command over redis: reply carries the checklist, ledger records the key', async () => {
    const command = 'pnpm add left-pad-throwaway-dep';
    const redis = new InMemoryRedisStream();
    const events: EngineEvent[] = [];
    const containers = fakeContainersWithProfileAwarenessCall(redis, command);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    const out = await runner.run({
      ...baseArgs((e) => events.push(e)),
      sandboxKey: { orgId: ORG_ID, repoId, jobId: 'job-1', type: 'build' },
      toolBridge: makeBridge(),
    });

    expect(out).toMatchObject({ result: 'DONE' });
    const replyText = events.find(
      (e) => (e as { kind?: string }).kind === 'text',
    ) as { kind: 'text'; text: string } | undefined;
    expect(replyText?.text).toContain('[profile-awareness]');
    expect(replyText?.text).toContain('pnpm:left-pad-throwaway-dep');

    const entries = await ledger();
    expect(entries.map((t) => t.key)).toEqual(['pnpm:left-pad-throwaway-dep']);
    expect(entries[0].firstSeenAt).toEqual(expect.any(String));
  });

  it('same command again over the same round-trip: deduped (empty reply text), ledger unchanged', async () => {
    const command = 'pnpm add left-pad-throwaway-dep';
    const before = await ledger();
    const redis = new InMemoryRedisStream();
    const events: EngineEvent[] = [];
    const containers = fakeContainersWithProfileAwarenessCall(redis, command);
    const runner = new RedisEngineRunner(
      containers,
      redis,
      fakeEnv,
      fakeActivity,
      fakeRegistry(),
    );

    await runner.run({
      ...baseArgs((e) => events.push(e)),
      sandboxKey: { orgId: ORG_ID, repoId, jobId: 'job-1', type: 'build' },
      toolBridge: makeBridge(),
    });

    const replyText = events.find(
      (e) => (e as { kind?: string }).kind === 'text',
    ) as { kind: 'text'; text: string } | undefined;
    // `service.handle` returns null on dedup; the tool-bridge reply's result is null, so the fake
    // container's text extraction (only a STRING result becomes text) yields an empty string.
    expect(replyText?.text).toBe('');
    expect(await ledger()).toEqual(before);
  });
});
