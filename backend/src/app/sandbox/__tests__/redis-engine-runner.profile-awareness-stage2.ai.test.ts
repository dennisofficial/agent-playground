/**
 * `RedisEngineRunner` + REAL `ProfileAwarenessService` WITH the REAL Stage-2 Haiku filter wired in (live
 * Postgres + a real Anthropic model call) — proves Stage 2's suppress/enrich behavior is observable
 * through the ACTUAL round-trip transport (the same `tool_request`/`tool_response` Redis streams the
 * in-container `PostToolUse` hook's `bridgeCall` uses), not just via a direct `filter.filter()` call.
 *
 * Mirrors `redis-engine-runner.profile-awareness.int.test.ts`'s harness exactly (DB bootstrap, fake
 * `ContainerEngine.execDetached` that XADDs a `tool_request` for the reserved `__profile_awareness` tool
 * and polls the replies stream) — that file proves the round-trip with Stage 1 only; this file is the
 * Stage-2 counterpart, with a REAL `AnthropicInstallAwarenessFilter` (no fake) bound behind
 * `INSTALL_AWARENESS_FILTER` instead of leaving it unbound.
 *
 * Real LLM call — runs only under `pnpm test:ai` with `ANTHROPIC_API_KEY` in the env (`describe.skip`
 * otherwise, same gate as `install-awareness-filter.ai.test.ts` / `autofix.stage.ai.test.ts`).
 */
import type { EnvService } from '@core/config/env/env.service';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import type { EngineEvent, RunEngineArgs } from '@shared/engine/engine.types';
import { agentMessage } from '@shared/prompt-kit/message';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { InMemoryRedisStream } from '../../../_lib/redis/in-memory-redis-stream';
import { WorkspaceConfigStore } from '../../onboarding/workspace-config.store';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES } from '../../persistence/entities';
import {
  AnthropicInstallAwarenessFilter,
  INSTALL_AWARENESS_FILTER,
} from '../../workspace-profile/install-awareness-filter';
import { ProfileAwarenessService } from '../../workspace-profile/profile-awareness.service';
import {
  WorkspaceProfileService,
  type WorkspaceProfileSnapshot,
} from '../../workspace-profile/workspace-profile.service';
import type { ContainerEngine } from '../container-engine.port';
import { RedisEngineRunner } from '../redis-engine-runner';
import { turnKeys } from '../redis-turn-keys';
import type { SandboxActivityRegistry } from '../sandbox-activity.registry';
import type { TurnRegistry } from '../turn-registry.service';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const describeLive = API_KEY ? describe : describe.skip;

const ORG_ID = '3cccccc3-3333-4333-8333-333333333333';

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
    register: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    finalize: vi.fn(async () => true),
    getToolReply: vi.fn(async () => null),
    recordToolReply: vi.fn(async () => undefined),
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

/** A BARE profile — no skills/MCP/setup — so a new lint tool has nothing already covering it. */
const BARE_SNAPSHOT: WorkspaceProfileSnapshot = {
  mounts: [],
  setupScript: { present: false, length: 0 },
  previewRecipe: { present: false, length: 0 },
  secretFiles: [],
  mcpServers: [],
  skills: [],
  houseStyle: null,
};

/** Mirrors `fakeContainersWithProfileAwarenessCall` from the Stage-1 round-trip test verbatim. */
function fakeContainersWithProfileAwarenessCall(redis: InMemoryRedisStream, command: string) {
  return {
    execDetached: vi.fn(
      async (_id: string, _argv: string[], opts?: { env?: Record<string, string> }) => {
        const turnId = opts?.env?.TURN_ID;
        if (!turnId) return {};
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
              const text = d.t === 'tool_response' && typeof d.result === 'string' ? d.result : '';
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
        return {};
      },
    ),
  } as unknown as ContainerEngine;
}

describeLive(
  'RedisEngineRunner + ProfileAwarenessService WITH the REAL Stage-2 Haiku filter (live Postgres + live model) — install-awareness round-trip',
  () => {
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
        providers: [
          WorkspaceConfigStore,
          ProfileAwarenessService,
          {
            provide: WorkspaceProfileService,
            useValue: {
              describe: async () => BARE_SNAPSHOT,
              render: () => '- Mounts: none',
            },
          },
          {
            provide: INSTALL_AWARENESS_FILTER,
            useValue: new AnthropicInstallAwarenessFilter(async () => API_KEY),
          },
        ],
      }).compile();

      service = mod.get(ProfileAwarenessService);
      ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

      await ds.query(
        `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Install Awareness Stage2 Org', 'install-awareness-stage2-org', 'active')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [ORG_ID],
      );
      const repoRows = await ds.query(
        `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'install-awareness-stage2-repo', 'Install Awareness Stage2 Repo', 'https://github.com/x/y.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
        [ORG_ID],
      );
      repoId = repoRows[0].id;
    });

    afterAll(async () => {
      await ds?.query(`DELETE FROM repos WHERE org_id = $1`, [ORG_ID]).catch(() => undefined);
      await ds?.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]).catch(() => undefined);
      await mod?.close();
    });

    async function ledger(): Promise<Array<{ key: string }>> {
      const rows = await ds.query(`SELECT profile_seen_tooling AS t FROM repos WHERE id = $1`, [
        repoId,
      ]);
      return rows[0].t ?? [];
    }

    function makeBridge() {
      return {
        jobId: 'job-1',
        tools: {
          __profile_awareness: (args: Record<string, unknown>) =>
            service.handle({
              orgId: ORG_ID,
              repoId,
              jobId: 'job-1',
              sessionType: 'build',
              command: String(args['command'] ?? ''),
            }),
        },
      };
    }

    async function roundTrip(command: string): Promise<string> {
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
        toolBridge: makeBridge() as never,
      });

      const replyText = events.find((e) => (e as { kind?: string }).kind === 'text') as
        | { kind: 'text'; text: string }
        | undefined;
      return replyText?.text ?? '';
    }

    it('a new lint tool on a bare profile: the REAL Stage-2 filter enriches the reply over the real transport', async () => {
      const text = await roundTrip('pnpm add stage2-live-eslint');

      // eslint-disable-next-line no-console
      console.log('[stage2-roundtrip] enrich case reply text:', JSON.stringify(text));
      expect(text).toContain('[profile-awareness]');
      expect(text).toContain('pnpm:stage2-live-eslint');
      // The real model must not merely echo Stage 1 — Stage 2 attaches a concrete suggestion when it
      // decides to keep a genuinely-new, uncovered tool (system prompt's "canonical KEEP" case).
      expect(text).toContain('Suggestion:');

      expect((await ledger()).map((t) => t.key)).toContain('pnpm:stage2-live-eslint');
    });

    it('a transient npx ad-hoc run: the REAL Stage-2 filter suppresses the reply over the real transport (ledger still records it)', async () => {
      const text = await roundTrip('npx stage2-live-create-foo');

      // eslint-disable-next-line no-console
      console.log('[stage2-roundtrip] suppress case reply text:', JSON.stringify(text));
      // Suppressed → `service.handle` returns null → the tool-bridge result is null → the fake
      // container's text extraction (only a STRING result becomes text) yields an empty string, exactly
      // like the Stage-1 dedup case in `redis-engine-runner.profile-awareness.int.test.ts`.
      expect(text).toBe('');

      // The ledger transition still committed (record-then-filter, decision d2) even though the text
      // shown to the agent was suppressed.
      expect((await ledger()).map((t) => t.key)).toContain('npx:stage2-live-create-foo');
    });
  },
);
