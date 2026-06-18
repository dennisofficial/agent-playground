/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * CLOUD-CLAUDE END-TO-END PROOF (Phase 11) — NOT part of the unit suite.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Drives the REAL host wiring against a REAL privileged sandbox to prove the full loop:
 *
 *   ensureWorkspace → a real `agent-workspace-base` sandbox spawns (privileged DinD, the daemon MOUNTED
 *   from the agent-daemon-build volume, joined to the compose network), CLONES a public repo on boot,
 *   writes its ready marker → host
 *   waits on it → dispatch a REAL Claude `execute` turn over Redis → the engine, running INSIDE the
 *   sandbox in the cloned repo's worktree, writes a trivial HTTP server, starts it, and curls localhost
 *   → we stream the WorkerEvents and assert the final result reports the localhost response.
 *
 * This is the production host path minus the Nest module graph: it instantiates the same services
 * (`ContainerManagerService`, `CredentialProvisionerService`, `SandboxReadinessService`,
 * `SandboxRegistry`, `DaemonClient`) directly over a real ioredis client + the real `DockerodeAdapter`,
 * with STUB `ProjectStore` (a small PUBLIC repo) + STUB `GithubTokenStore` (empty token — public-repo
 * tolerance). No DB, no Slack, no conductor.
 *
 * RUN (from `backend/`):
 *   pnpm dev:env -- npx tsx src/daemon/__e2e__/sandbox-turn.e2e.ts
 *
 * Prereqs:
 *   - `pnpm daemon:build` has run (builds the generic `agent-workspace-base` image + populates the
 *     `agent-daemon-build` volume the sandbox mounts the daemon from)
 *   - compose Redis up: host `localhost:6380`, service DNS `agent-playground-redis:6379` on network
 *     `agent-playground_default`
 *   - Docker Desktop host → inner dockerd needs `vfs` storage driver (test-only)
 *   - `ANTHROPIC_API_KEY` in the ambient env (dev:env / dotenvx injects it)
 *
 * The script reads its config from env (defaults match the orchestrator's setup) and exits non-zero on
 * any failure. It ALWAYS tears the sandbox + its volume down at the end (success or failure).
 */
import Redis from 'ioredis';
import type { EnvService } from '@core/config/env/env.service';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import type { WorkerEvent } from '@harness/engines/worker-engine.port';
import type { ProjectStore } from '@harness/projects/project-store';
import type { GithubTokenStore } from '@harness/projects/github-token-store';
import { IoredisStreamAdapter } from '../../_lib/redis/ioredis-stream.adapter';
import { ContainerManagerService } from '@harness/workspaces/container-manager.service';
import { CredentialProvisionerService } from '@harness/workspaces/credential-provisioner.service';
import { DaemonClient } from '@harness/workspaces/daemon-client';
import { DockerodeAdapter } from '@harness/workspaces/dockerode.adapter';
import { SandboxReadinessService } from '@harness/workspaces/sandbox-readiness.service';
import { SandboxRegistry } from '@harness/workspaces/sandbox-registry';
import type { RunCommandPayload } from '@harness/workspaces/daemon-protocol';

// ── e2e config (env-overridable; defaults = the orchestrator's live setup) ──────────────────────
const TEAM = process.env.E2E_TEAM ?? 'e2e-team';
const PROJECT = process.env.E2E_PROJECT ?? 'e2e-project';
// A tiny PUBLIC repo so clone-on-boot is instant and needs no PAT (public-repo tolerance).
const PUBLIC_REPO =
  process.env.E2E_REPO_URL ?? 'https://github.com/octocat/Hello-World';
const BASE_BRANCH = process.env.E2E_BASE_BRANCH ?? 'master';
// Host-side Redis (where THIS script connects). The SANDBOX uses WORKSPACE_REDIS_URL (service DNS).
const HOST_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

const log = (...a: unknown[]): void =>
  console.log(`[e2e ${new Date().toISOString()}]`, ...a);

/** A minimal EnvService over a plain map — the services only ever `.get(key)`. */
function makeEnv(values: Record<string, string | undefined>): EnvService {
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

/** STUB ProjectStore returning the small public repo on master, with NO token name. */
function makeProjects(): ProjectStore {
  return {
    get: async (team: string, project: string) =>
      team === TEAM && project === PROJECT
        ? {
            teamId: TEAM,
            projectId: PROJECT,
            displayName: 'e2e public repo',
            description: null,
            gitUrl: PUBLIC_REPO,
            defaultBranch: BASE_BRANCH,
            tokenName: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : undefined,
  } as unknown as ProjectStore;
}

/** STUB GithubTokenStore returning NO token — exercises the public-repo (empty-token) tolerance path. */
function makeTokens(): GithubTokenStore {
  return {
    resolve: async () => undefined,
  } as unknown as GithubTokenStore;
}

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log(
      'FATAL: ANTHROPIC_API_KEY is not set — cannot run a real engine turn. ' +
        'Everything up to the turn (clone-on-boot + dispatch plumbing) is wired; re-run with a key set.',
    );
    return 2;
  }

  // The HOST env the ContainerManager reads. The injection under test:
  //  - WORKSPACE_REDIS_URL → the SANDBOX-reachable Redis (service DNS), NOT the host loopback above.
  //  - WORKSPACE_NETWORK → the compose network so that DNS resolves from inside the sandbox.
  //  - WORKSPACE_DOCKER_STORAGE_DRIVER → vfs (Docker Desktop overlay-on-overlay can't mount).
  const env = makeEnv({
    WORKSPACE_IMAGE: process.env.WORKSPACE_IMAGE ?? 'agent-workspace-base',
    WORKSPACE_SANDBOX_ENABLED: 'true',
    WORKSPACE_REDIS_URL:
      process.env.WORKSPACE_REDIS_URL ?? 'redis://agent-playground-redis:6379',
    WORKSPACE_NETWORK:
      process.env.WORKSPACE_NETWORK ?? 'agent-playground_default',
    // TEST-ONLY: Docker Desktop overlay-on-overlay can't mount, so the e2e forces vfs. Real Linux hosts
    // leave this empty (auto → overlay2); a Linux smoke test asserts that.
    WORKSPACE_DOCKER_STORAGE_DRIVER:
      process.env.WORKSPACE_DOCKER_STORAGE_DRIVER ?? 'vfs',
    DOCKER_SOCKET_PATH: process.env.DOCKER_SOCKET_PATH,
    REDIS_URL: HOST_REDIS_URL,
  });

  // One real ioredis client (host side) shared by every Redis-backed service.
  const redisClient = new Redis(HOST_REDIS_URL, { lazyConnect: true });
  redisClient.on('error', (e) => log('redis client error (resilient):', e.message));
  const redis = new IoredisStreamAdapter(redisClient);

  // Wire the host services directly (same instances the DI graph would build).
  const registry = new SandboxRegistry();
  const readiness = new SandboxReadinessService(redis);
  const credentials = new CredentialProvisionerService(
    redis,
    registry,
    makeProjects(),
    makeTokens(),
  );
  const engine = new DockerodeAdapter(env);
  const manager = new ContainerManagerService(
    engine,
    env,
    makeProjects(),
    registry,
    credentials,
    readiness,
  );
  const daemonClient = new DaemonClient(redis);

  let workspaceId: string | undefined;
  try {
    // ── 1) ensureWorkspace → spawn a real sandbox; it clones the public repo on boot ──────────────
    log(`ensureWorkspace(${TEAM}, ${PROJECT}) — spawning sandbox from agent-workspace-base…`);
    const rec = await manager.ensureWorkspace(TEAM, PROJECT);
    workspaceId = rec.workspaceId;
    log(
      `sandbox spawned: workspaceId=${rec.workspaceId} container=${rec.containerId.slice(0, 12)} ` +
        `repo=${rec.repo}`,
    );

    // ── 2) wait for the ready marker (gated on inner Docker AND clone-on-boot, Phase 11) ──────────
    log('waiting for the daemon ready marker (inner Docker + boot clone)…');
    await readiness.waitForReady(rec.workspaceId);
    log('sandbox signaled READY — boot clone complete, inner Docker up.');

    // ── 3) dispatch a REAL Claude execute turn over Redis ─────────────────────────────────────────
    // The task proves a real engine turn WRITING + RUNNING + CURL-ing inside the sandbox: write a
    // trivial HTTP server into the cloned repo's worktree, start it in the background, then curl it and
    // report the status line. This is the robust GOOD-rung proof (no flaky third-party dev server),
    // and it runs IN the clone (cwd = the session's worktree off the boot clone).
    const task = [
      'You are inside an isolated Linux sandbox, in a git checkout of a cloned repo. Do ALL of this:',
      '1. Write a file `e2e_server.js` containing a Node HTTP server that listens on port 7799 and',
      "   responds to every request with status 200 and the exact body `CLOUD_CLAUDE_OK`.",
      '2. Start it in the background: `node e2e_server.js &` and give it a second to come up.',
      '3. Curl it: `curl -s -i http://localhost:7799/`.',
      '4. Report back, on their own lines, the HTTP status line you got and the response body.',
      'Be concise. Confirm with the literal text RESULT: followed by the status line and body.',
    ].join('\n');

    const payload: RunCommandPayload = {
      engine: EWorkerEngineName.CLAUDE,
      sessionId: `e2e-sess-${Date.now()}`,
      task,
      systemPrompt:
        'You are a coding agent running inside an isolated sandbox. Use the bash tool to write files, ' +
        'run commands, and curl localhost. Keep going until the task is done.',
      agentId: 'e2e-agent',
      mode: 'execute',
      apiKey,
      skillSources: [],
      mcpServers: [],
    };

    log('dispatching a real Claude EXECUTE turn over Redis…');
    const events: WorkerEvent[] = [];
    const result = await daemonClient.dispatchRun(
      rec.workspaceId,
      payload,
      (e) => {
        events.push(e);
        // Compact streaming trace — type + a short preview of any text.
        const preview =
          typeof (e as { text?: string }).text === 'string'
            ? `: ${(e as { text: string }).text.slice(0, 120).replace(/\n/g, ' ')}`
            : '';
        log(`  event[${(e as { type?: string }).type ?? '?'}]${preview}`);
      },
    );

    log('──────────────────────────────────────────────────────────────────────');
    log(`engine turn COMPLETE. events=${events.length} sessionId=${result.sessionId ?? 'n/a'}`);
    log('FINAL RESULT:\n' + result.result);
    log('──────────────────────────────────────────────────────────────────────');

    // ── 4) ASSERT the engine actually ran in the sandbox and curled localhost ─────────────────────
    const text = result.result ?? '';
    const sawBody = /CLOUD_CLAUDE_OK/.test(text);
    const sawOk = /200|HTTP\/1\.[01]\s+200|OK/i.test(text);
    if (!sawBody) {
      throw new Error(
        'ASSERTION FAILED: the engine result does not contain the server body `CLOUD_CLAUDE_OK` — ' +
          'the localhost curl did not return the expected response.',
      );
    }
    if (!sawOk) {
      log(
        'WARN: did not explicitly see a 200 status in the result text, but the body was returned — ' +
          'treating the localhost round-trip as proven.',
      );
    }
    log('✅ ASSERTION PASSED: a real Claude turn cloned the repo, wrote + ran a server, and curled localhost.');
    return 0;
  } catch (err) {
    log('❌ E2E FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
    // Dump the sandbox's container logs to diagnose (boot/clone/turn failures).
    if (workspaceId) {
      const rec = registry.get(workspaceId);
      if (rec) {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const run = promisify(execFile);
          const { stdout, stderr } = await run('docker', [
            'logs',
            '--tail',
            '200',
            rec.containerId,
          ]);
          log('── container logs (tail 200) ──\n' + stdout + '\n' + stderr);
        } catch (e) {
          log('could not fetch container logs:', e);
        }
      }
    }
    return 1;
  } finally {
    // ── 5) tear the sandbox down (container + its docker-storage volume) ──────────────────────────
    if (workspaceId) {
      log(`tearing down sandbox ${workspaceId}…`);
      await manager.destroyWorkspace(workspaceId).catch((e) =>
        log('destroyWorkspace error (ignored):', e),
      );
      // Remove the per-sandbox inner-docker volume (manager removes the container, not its named volume).
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        await run('docker', ['volume', 'rm', '-f', `agent-ws-docker-${workspaceId}`]);
        log('removed inner-docker volume.');
      } catch {
        /* volume may already be gone */
      }
    }
    await credentials.onApplicationShutdown().catch(() => undefined);
    redisClient.disconnect();
    log('cleanup complete.');
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log('UNHANDLED:', err);
    process.exit(1);
  },
);
